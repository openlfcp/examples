import {
  createQueuedDataUnit,
  DataUnitApplier,
  dekResolver,
  loadControlChain,
  OutboundQueue,
  ProfileCheckpointer,
  type ResourceRefusal,
  SyncClient,
  type SyncEvent,
  saveControlChain,
  startSyncDriver,
} from "@openlfcp/client";
import {
  actorSequence,
  type DataUnitId,
  dataEpoch,
  generateResourceId,
  type ResourceId,
} from "@openlfcp/core";
import {
  type AgreementKeyPair,
  dekCommitment,
  exportSecretKeyBytes,
  generateResourceDEK,
} from "@openlfcp/crypto";
import {
  checkChange,
  PROFILE_ID,
  type ReplicaIntent,
  SharedObjectsDataProfile,
  SharedObjectsReplica,
} from "@openlfcp/shared-objects";
import {
  SECTIONS_PROFILE_ID,
  SectionReplica,
  SharedSectionsDataProfile,
} from "@openlfcp/shared-objects/sections";
import { dekSecretRef, principalKeySecretRef } from "@openlfcp/storage";
import {
  type ChainResult,
  type Signer,
  signControlRecord,
  validateControlChain,
} from "@openlfcp/wire";
import { CliError, type Home, showResource } from "./home.js";

/**
 * Everything the CLI does with LFCP, through the SDK only: no CBOR, COSE,
 * key derivation or Automerge internals here. Writes go intent → Automerge
 * change → §11 framing → encrypted, signed Data Unit → one atomic commit
 * with the outbound entry and the profile checkpoint. The network is the
 * SyncClient (LFCP-039a) over a real LFCP WebSocket session.
 */

export type Linear = Extract<ChainResult, { kind: "linear" }>;
export type Who = { readonly signer: Signer; readonly agreement: AgreementKeyPair };
/** A Resource's application state, by the Data Profile its Genesis names. */
export type Profile = SharedObjectsDataProfile | SharedSectionsDataProfile;
/** The Data Profiles this CLI opens: legacy Shared Objects Tasks and shared sections. */
export const PROFILES = [PROFILE_ID, SECTIONS_PROFILE_ID] as const;

export async function chainOf(home: Home, R: ResourceId): Promise<Linear> {
  const chain = await loadControlChain(home.storage, R);
  if (chain === undefined) throw new CliError("this home does not hold that Resource");
  if (chain.kind !== "linear")
    throw new CliError(`the stored Control Chain is not usable (${chain.kind})`);
  return chain;
}

/**
 * The Resource's application state, restored from its checkpoint or empty.
 * Which profile is dispatched by the validated Genesis, never by a name or
 * a reference shape (SHARED-SECTIONS-PROFILE-01 §20).
 */
export async function openProfile(home: Home, R: ResourceId, who: Who): Promise<Profile> {
  const chain = await chainOf(home, R);
  const options = { resource: R, principal: who.signer.descriptor.principalId };
  const checkpoint = await home.storage.profileState.checkpoint(R);
  switch (chain.state.dataProfile) {
    case PROFILE_ID:
      return checkpoint === undefined
        ? new SharedObjectsDataProfile(SharedObjectsReplica.empty(options))
        : SharedObjectsDataProfile.restore(checkpoint, options);
    case SECTIONS_PROFILE_ID:
      return checkpoint === undefined
        ? new SharedSectionsDataProfile(SectionReplica.empty(options))
        : SharedSectionsDataProfile.restore(checkpoint, options);
    default:
      throw new CliError(`lfcp-todo cannot open the Data Profile ${chain.state.dataProfile}`);
  }
}

/**
 * One local intent as this Principal's next Data Unit. The unit, its
 * outbound entry and the profile checkpoint (with the change's unit
 * reference) are committed together; a crash leaves none or all of them.
 */
export async function writeIntent(
  home: Home,
  R: ResourceId,
  who: Who,
  profile: SharedObjectsDataProfile,
  intent: ReplicaIntent | null,
): Promise<DataUnitId | null> {
  if (intent === null) return null;
  const local = profile.replica.apply(intent);
  if (local === null) return null;
  return writeChange(home, R, who, profile, local.change);
}

async function writeChange(
  home: Home,
  R: ResourceId,
  who: Who,
  profile: SharedObjectsDataProfile,
  change: Uint8Array,
): Promise<DataUnitId> {
  const chain = await chainOf(home, R);
  const epoch = chain.state.epoch.epoch;
  const dek = await dekResolver(home.storage, home.secrets, R)(epoch);
  if (dek === undefined) throw new CliError(`no key for Data Epoch ${epoch}: run sync first`);
  const me = who.signer.descriptor.principalId;
  const mine = await home.storage.dataUnits.range(
    R,
    me,
    actorSequence(1n),
    actorSequence(2n ** 64n - 1n),
  );
  const previous = mine.filter((u) => u.accepted).at(-1)?.unitId ?? null;
  const created = await createQueuedDataUnit(
    home.storage,
    {
      view: chain,
      controlHead: chain.state.head,
      actor: who.signer,
      dek,
      profile: profile.codecFor({ resourceId: R, actor: me }),
      previousUnitId: previous,
      value: checkChange(change),
      onCreated: (c, value) => profile.recordLocal(c.unitId, value),
    },
    () => [{ op: "put-profile-checkpoint", checkpoint: profile.checkpoint() }],
  );
  return created.unitId;
}

/**
 * A new Resource (§15): a random Resource ID, a fresh epoch-0 DEK, the
 * Genesis signed by the local Principal with the Shared Objects profile,
 * and the profile's initial document as this Principal's first Data Unit.
 * The DEK goes into the secret store before any row names it.
 */
export async function createResource(
  home: Home,
  who: Who,
  name: string,
  endpoints: readonly string[],
  coordinatorUrl: string,
  dataProfile: (typeof PROFILES)[number] = PROFILE_ID,
): Promise<ResourceId> {
  const R = generateResourceId();
  const dek = generateResourceDEK();
  const epoch0 = dataEpoch(0n);
  let genesis: { bytes: Uint8Array };
  try {
    genesis = signControlRecord(
      { resourceId: R, controlSeq: 0n, prevControlId: null },
      {
        type: "GENESIS",
        dataProfile,
        owner: who.signer.descriptor,
        dekCommitment: dekCommitment(R, epoch0, dek),
        endpoints: endpoints.map((url, i) => ({ url, priority: BigInt(i) })),
        coordinatorUrl,
      },
      who.signer,
    );
  } catch (e) {
    throw new CliError(`the endpoints are not usable: ${(e as Error).message}`);
  }
  const chain = validateControlChain([genesis.bytes]);
  if (chain.kind !== "linear") throw new CliError("the Genesis does not validate");
  await home.secrets.put(dekSecretRef(R, epoch0), exportSecretKeyBytes(dek));
  const saved = await saveControlChain(home.storage, chain, null);
  if (!saved.ok) throw new CliError(`the Resource was not stored: ${saved.reason}`);
  await registerResource(home, R, who, name, dataProfile);
  // A section Resource starts empty: its first batch, section.create, is committed by the caller.
  if (dataProfile === SECTIONS_PROFILE_ID) return R;
  const { replica, change } = SharedObjectsReplica.create({
    resource: R,
    principal: who.signer.descriptor.principalId,
  });
  const profile = new SharedObjectsDataProfile(replica);
  await writeChange(home, R, who, profile, change.change);
  return R;
}

/**
 * The Resource row (the local Principal and where its keys are, a display
 * name) and the DEK references of the epochs whose key is in the secret
 * store.
 */
export async function registerResource(
  home: Home,
  R: ResourceId,
  who: Who,
  name: string,
  dataProfile: string,
): Promise<void> {
  const me = who.signer.descriptor.principalId;
  const writes = [];
  for (const row of await home.storage.control.epochs(R)) {
    const ref = dekSecretRef(R, row.epoch);
    if (row.dekRef === null && (await home.secrets.get(ref)) !== undefined)
      writes.push({ op: "put-epoch" as const, resourceId: R, epoch: { ...row, dekRef: ref } });
  }
  const result = await home.storage.commit([
    ...writes,
    {
      op: "put-resource",
      row: {
        resourceId: R,
        dataProfile,
        localPrincipal: {
          principalId: me,
          signingKeyRef: principalKeySecretRef(me, "signing"),
          agreementKeyRef: principalKeySecretRef(me, "agreement"),
        },
        labels: { name },
      },
    },
  ]);
  if (!result.ok) throw new CliError(`the Resource was not stored: ${result.reason}`);
}

/** The URL to synchronize with: --url, else the Resource's Control Coordinator (§16, §20). */
export async function urlOf(home: Home, R: ResourceId, url: string | undefined): Promise<string> {
  if (url !== undefined) return url;
  const route = await home.storage.resources.route(R);
  if (route === undefined) throw new CliError("no known route for this Resource: pass --url");
  return route.coordinatorUrl;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The one-line error for a server's terminal refusal of a Resource (POST-017),
 * naming the server and the Resource, then the §62 code.
 */
export function refusalMessage(R: ResourceId, refusal: ResourceRefusal): string {
  const id = showResource(R);
  const why = refusal.diagnostic === undefined ? "" : `: ${refusal.diagnostic}`;
  switch (refusal.code) {
    case "RESOURCE_NOT_HOSTED":
      return `server ${refusal.url} does not host Resource ${id} (RESOURCE_NOT_HOSTED${why})`;
    case "AUTHORIZATION_FAILED":
      return `server ${refusal.url} refused Resource ${id}: this Principal may not read it (AUTHORIZATION_FAILED${why})`;
    case "RESOURCE_TOMBSTONED":
      return `server ${refusal.url} says Resource ${id} was deleted (RESOURCE_TOMBSTONED${why})`;
    default:
      return `server ${refusal.url} refused Resource ${id} (${refusal.code}${why})`;
  }
}

/** One LFCP session for one Resource: SyncClient, applier, outbound queue and checkpoints. */
export class Session {
  readonly client: SyncClient;
  readonly applier: DataUnitApplier;
  readonly checkpointer: ProfileCheckpointer;
  readonly events: SyncEvent[] = [];
  readonly #reconnect: boolean;
  #stopDriver: (() => void) | null = null;

  constructor(
    readonly home: Home,
    readonly R: ResourceId,
    readonly who: Who,
    readonly profile: Profile,
    readonly url: string,
    options: { reconnect: boolean },
  ) {
    this.#reconnect = options.reconnect;
    this.applier = new DataUnitApplier({
      storage: home.storage,
      dek: dekResolver(home.storage, home.secrets, R),
      handlers: [
        {
          dataProfile: profile.dataProfile,
          codecFor: (u) => profile.codecFor(u),
          apply: (u, v) => profile.apply(u, v as never),
          exclude: (ids) => profile.exclude(ids),
          has: (id) => profile.has(id),
          reset: () => profile.reset(),
        },
      ],
    });
    this.checkpointer = new ProfileCheckpointer(home.storage, profile, { minIntervalMs: 0 });
    this.client = new SyncClient({
      url,
      signer: who.signer,
      agreement: who.agreement,
      storage: home.storage,
      secrets: home.secrets,
      outbound: new OutboundQueue({ storage: home.storage }),
      now: () => Date.now(),
      reconnect: options.reconnect ? (n) => Math.min(30_000, 500 * 2 ** (n - 1)) : () => null,
      antiEntropyMs: 2000,
    });
    this.client.on((e) => this.events.push(e));
  }

  start(): void {
    this.#stopDriver = startSyncDriver(
      this.client,
      {
        setInterval: (fn, interval) => setInterval(fn, interval),
        clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
        now: Date.now,
      },
      100,
    );
    this.client.start();
  }

  async waitFor(what: string, cond: () => boolean | Promise<boolean>, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await cond()) return;
      // A terminal refusal (POST-017): nothing will change by waiting.
      const refusal = this.client.resourceRefusal(this.R);
      if (refusal !== null) throw new CliError(refusalMessage(this.R, refusal));
      // A one-shot session does not reconnect: a lost connection ends it.
      const lost = this.events.find((e) => e.type === "connection" && e.reason !== undefined);
      if (!this.#reconnect && lost?.type === "connection")
        throw new CliError(`the connection closed: ${lost.reason}`);
      if (Date.now() > deadline) throw new CliError(`timed out waiting for ${what}`);
      await sleep(50);
    }
  }

  async ready(ms: number): Promise<void> {
    await this.waitFor("the LFCP session", () => this.client.connectionState === "READY", ms);
  }

  open(): void {
    const profile = this.profile;
    this.client.open({
      resourceId: this.R,
      applier: this.applier,
      checkpointer: this.checkpointer,
      // Sections write batches with receipts (SDK-SECTIONS-INTEGRATION-01 §3).
      ...(profile instanceof SharedSectionsDataProfile
        ? { commit: profile.commitBinding(this.who.signer.descriptor.principalId) as never }
        : {}),
    });
  }

  /** LIVE (caught up with the server) with nothing left in the outbound queue. */
  async synced(ms: number): Promise<void> {
    await this.waitFor(
      "the Resource to be in sync",
      async () =>
        this.client.resourceState(this.R) === "LIVE" &&
        (await this.home.storage.outbound.list(this.R)).filter((i) => i.blocked === null).length ===
          0,
      ms,
    );
    await this.client.idle();
  }

  async stop(): Promise<void> {
    this.#stopDriver?.();
    await this.client.stop();
    if (this.checkpointer.dirty) await this.checkpointer.flush(Date.now());
  }
}
