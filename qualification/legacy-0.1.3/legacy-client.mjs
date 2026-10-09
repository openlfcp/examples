// The released 0.1.3 client in its own process, for the integrated recovery
// qualification (LFCP-02-070). It runs only the npm packages installed
// here (npm ci), never the candidate code, on SQLite and a file secret
// store in a vault directory, against a live server.
//
//   node legacy-client.mjs <command> '<json arguments>'
//
// Commands, each printing one JSON object per line:
//   owner  {dir, url, seed, resource, dek, task}
//          creates and hosts a Shared Objects Resource with one Task, waits
//          for the ACK, issues one invitation (printed), then goes offline,
//          writes two title edits that stay queued, and exits without
//          stopping: the queue is left for the next build to send.
//   join   {dir, url, seed, link, profiles}
//          accepts an invitation, offering only `profiles`.
//   open   {dir, resource}
//          opens the vault's database and reads the Resource's Control Head.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  acceptInvitation,
  createInvitation,
  createQueuedDataUnit,
  DataUnitApplier,
  dekResolver,
  loadControlChain,
  OutboundQueue,
  ProfileCheckpointer,
  SyncClient,
  saveControlChain,
  startSyncDriver,
} from "@openlfcp/client";
import { dataEpoch, fromHex, resourceId, toHex } from "@openlfcp/core";
import {
  dekCommitment,
  exportSecretKeyBytes,
  importAgreementKey,
  importResourceDEK,
  importSigningKey,
} from "@openlfcp/crypto";
import {
  checkChange,
  createTask,
  SharedObjectsDataProfile,
  SharedObjectsReplica,
  setTitle,
} from "@openlfcp/shared-objects";
import { dekSecretRef } from "@openlfcp/storage";
import { FileSecretStore, SqliteLfcpStorage } from "@openlfcp/storage-node";
import {
  principalDescriptorFromKeys,
  signControlRecord,
  validateControlChain,
} from "@openlfcp/wire";

const [command, json] = process.argv.slice(2);
const args = JSON.parse(json ?? "{}");
const out = (o) =>
  process.stdout.write(
    `${JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? toHex(v) : v))}\n`,
  );
const bytes32 = (from) => Uint8Array.from({ length: 32 }, (_, i) => (from + i) & 0xff);
const party = (seed) => {
  const key = importSigningKey(bytes32(seed));
  const agreement = importAgreementKey(bytes32(seed + 100));
  return { signer: { key, descriptor: principalDescriptorFromKeys(key, agreement) }, agreement };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, check, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out: ${what}`);
}

const vault = (dir) => {
  mkdirSync(dir, { recursive: true });
  return {
    storage: SqliteLfcpStorage.open(join(dir, "lfcp.sqlite")),
    secrets: new FileSecretStore(join(dir, "secrets")),
  };
};

async function owner() {
  const me = party(args.seed);
  const R = resourceId(fromHex(args.resource));
  const dek = importResourceDEK(bytes32(args.dek));
  const { storage, secrets } = vault(args.dir);
  const principal = me.signer.descriptor.principalId;
  const { replica, change: init } = SharedObjectsReplica.create({ resource: R, principal });
  const profile = new SharedObjectsDataProfile(replica);
  const checkpointer = new ProfileCheckpointer(storage, profile, { minIntervalMs: 0 });
  const applier = new DataUnitApplier({
    storage,
    dek: dekResolver(storage, secrets, R),
    handlers: [
      {
        dataProfile: profile.dataProfile,
        codecFor: (u) => profile.codecFor(u),
        apply: (u, v) => profile.apply(u, v),
        exclude: (ids) => profile.exclude(ids),
        has: (id) => profile.has(id),
        reset: () => profile.reset(),
      },
    ],
  });
  const client = new SyncClient({
    url: args.url,
    signer: me.signer,
    agreement: me.agreement,
    storage,
    secrets,
    outbound: new OutboundQueue({ storage }),
    now: () => Date.now(),
    reconnect: () => 200,
    antiEntropyMs: 500,
  });
  client.on((e) => {
    if (e.type === "error") out({ t: "error", code: e.code, message: e.message });
  });

  // The Genesis and the epoch-0 DEK, stored before anything is sent.
  const genesis = signControlRecord(
    { resourceId: R, controlSeq: 0n, prevControlId: null },
    {
      type: "GENESIS",
      dataProfile: profile.dataProfile,
      owner: me.signer.descriptor,
      dekCommitment: dekCommitment(R, dataEpoch(0n), dek),
      endpoints: [{ url: args.url, priority: 0n }],
      coordinatorUrl: args.url,
    },
    me.signer,
  );
  const chain0 = validateControlChain([genesis.bytes]);
  if (chain0.kind !== "linear") throw new Error(chain0.kind);
  if (!(await saveControlChain(storage, chain0, null)).ok) throw new Error("Genesis not stored");
  const ref = dekSecretRef(R, dataEpoch(0n));
  await secrets.put(ref, exportSecretKeyBytes(dek));
  const row = (await storage.control.epochs(R)).find((e) => e.epoch === 0n);
  await storage.commit([{ op: "put-epoch", resourceId: R, epoch: { ...row, dekRef: ref } }]);

  const write = async (local) => {
    const chain = await loadControlChain(storage, R);
    const key = await dekResolver(storage, secrets, R)(chain.state.epoch.epoch);
    const mine = (await storage.dataUnits.range(R, principal, 1n, 2n ** 64n - 1n)).at(-1);
    const u = await createQueuedDataUnit(
      storage,
      {
        view: chain,
        controlHead: chain.state.head,
        actor: me.signer,
        dek: key,
        profile: profile.codecFor({ resourceId: R, actor: principal }),
        previousUnitId: mine?.unitId ?? null,
        value: checkChange(local.change),
        onCreated: (created, value) => profile.recordLocal(created.unitId, value),
      },
      () => [checkpointer.write()],
    );
    client.flush();
    return u;
  };
  const queued = async () => (await storage.outbound.list(R)).length;

  client.start();
  const stopDriver = startSyncDriver(
    client,
    { setInterval, clearInterval, now: () => Date.now() },
    50,
  );
  await waitFor("READY", () => client.connectionState === "READY");
  await client.host(genesis.bytes);
  client.open({ resourceId: R, applier, checkpointer });
  await waitFor("LIVE", () => client.resourceState(R) === "LIVE");
  await write(init);
  await write(
    profile.replica.apply(
      createTask({ id: args.task, title: "Legacy task", createdBy: principal }).intent,
    ),
  );
  await waitFor("sent", async () => (await queued()) === 0);
  const invitation = await createInvitation({
    storage,
    resourceId: R,
    inviter: me.signer,
    dek,
    endpoints: [args.url],
  });
  client.flush();
  await waitFor("invitation sent", async () => (await queued()) === 0);
  // A synthetic test invitation: revealed for the test to pass to the joiner.
  out({ t: "invitation", link: invitation.link.reveal() });

  // Offline: two edits stay queued.
  stopDriver();
  await client.stop();
  for (const title of ["Offline edit 1", "Offline edit 2"]) {
    const u = await write(
      profile.replica.apply(setTitle(profile.replica.task(args.task).task, title).intent),
    );
    out({ t: "wrote", seq: u.seq, unitId: u.unitId });
  }
  await checkpointer.write();
  out({ t: "pending", queued: await queued(), title: profile.replica.task(args.task).task.title });
  process.exit(0);
}

async function joinCommand() {
  const me = party(args.seed);
  const { storage, secrets } = vault(args.dir);
  const result = await acceptInvitation({
    link: args.link,
    claimant: me,
    storage,
    secrets,
    url: args.url,
    now: () => Date.now(),
    timeout: sleep(20_000),
    dataProfiles: args.profiles,
  });
  out({
    t: "joined",
    kind: result.kind,
    code: result.code ?? null,
    dataProfile: result.dataProfile ?? null,
  });
  storage.close();
}

async function openCommand() {
  try {
    const storage = SqliteLfcpStorage.open(join(args.dir, "lfcp.sqlite"));
    const head = await storage.control.head(resourceId(fromHex(args.resource)));
    out({ t: "opened", controlSeq: head?.controlSeq ?? null });
    storage.close();
  } catch (e) {
    out({
      t: "refused",
      name: e?.name ?? null,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

const commands = { owner, join: joinCommand, open: openCommand };
if (!(command in commands)) {
  console.error("usage: legacy-client.mjs owner|join|open '<json>'");
  process.exit(2);
}
await commands[command]();
