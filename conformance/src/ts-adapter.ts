// The TypeScript side of the cross-language conformance harness (LFCP-070).
//
//   node dist/ts-adapter.js produce <dir>   writes <dir>/bundle.json
//   node dist/ts-adapter.js consume <dir>   reads it, writes <dir>/results-ts.json
//
// The bundle format (lfcp-interop-bundle/1) and the check IDs are shared with
// the Rust adapter (openlfcp/sdk-rs crates/lfcp/examples/interop.rs). Objects
// are generated fresh with production randomness and exchanged as their
// protocol bytes; keys are synthetic, made for one run. A DEK is never
// written out: consumers recover it from the Key Packages.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  actorSequence,
  type ControlRecordId,
  dataEpoch,
  fromHex,
  generateObjectId,
  hash32,
  LfcpError,
  type PrincipalId,
  type ResourceId,
  resourceId,
  secureRandom,
  toHex,
} from "@openlfcp/core";
import {
  type AgreementKeyPair,
  decryptDataUnit,
  decryptSnapshot,
  dekCommitment,
  deriveActorDataKey,
  deriveSnapshotKey,
  exportSecretKeyBytes,
  generateAgreementKeyPair,
  generateResourceDEK,
  generateSigningKeyPair,
  importAgreementKey,
  importSigningKey,
  type ResourceDEK,
  type SigningKeyPair,
} from "@openlfcp/crypto";
import {
  addTag,
  createTask,
  deleteTask,
  deriveActorId,
  frameChange,
  type Json,
  type LocalChange,
  removeTag,
  SharedObjectsDataProfile,
  SharedObjectsReplica,
  setTitle,
  unframeChange,
  unframeSnapshot,
} from "@openlfcp/shared-objects";
import {
  type ActorHave,
  type AnyMessage,
  abilitiesOf,
  type ControlBody,
  type ControlState,
  checkDataUnit,
  checkSnapshot,
  dataUnitAad,
  decodeMessage,
  decodePrincipalDescriptor,
  encodeMessage,
  encodePrincipalDescriptor,
  InMemorySeenUnits,
  openKeyPackage,
  type PrincipalDescriptor,
  parseKeyPackage,
  principalDescriptorFromKeys,
  type Signer,
  sealDataUnit,
  sealKeyPackage,
  sealSnapshot,
  signAuthProof,
  signControlRecord,
  snapshotAad,
  validateControlChain,
  verifyAuthProof,
  verifyKeyPackage,
} from "@openlfcp/wire";
import { consumeSections, produceSections } from "./sections-ts.js";

const FORMAT = "lfcp-interop-bundle/1";
const PROFILE = "org.openlfcp.shared-objects.v1";
const URL = "wss://interop.example.test/v1/ws";
const PRINCIPALS = ["owner", "bob", "carol", "invite", "dave"] as const;
type Name = (typeof PRINCIPALS)[number];
const SCALAR_FIELDS = [
  "lifecycle",
  "title",
  "status",
  "due",
  "scheduled",
  "completion_date",
  "priority",
];
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const rnd = (n: number): Uint8Array => secureRandom(n);
// biome-ignore lint/suspicious/noExplicitAny: the bundle is untyped JSON.
type Bundle = any;

interface Party {
  signer: Signer;
  signing: SigningKeyPair;
  agreement: AgreementKeyPair;
  seed: Uint8Array;
  x25519: Uint8Array;
}

function party(seed: Uint8Array, x25519: Uint8Array): Party {
  const signing = importSigningKey(seed);
  const agreement = importAgreementKey(x25519);
  return {
    signer: { key: signing, descriptor: principalDescriptorFromKeys(signing, agreement) },
    signing,
    agreement,
    seed,
    x25519,
  };
}

/** A fresh party: random keys, exported so the consumer can open packages. */
function freshParty(): Party {
  const signing = generateSigningKeyPair();
  const agreement = generateAgreementKeyPair();
  return party(exportSecretKeyBytes(signing), exportSecretKeyBytes(agreement));
}

// ---------------------------------------------------------------- produce

async function produce(dir: string): Promise<void> {
  const R = resourceId(rnd(32));
  const p = Object.fromEntries(PRINCIPALS.map((n) => [n, freshParty()])) as Record<Name, Party>;
  const id = (n: Name): PrincipalId => p[n].signer.descriptor.principalId;
  const desc = (n: Name): PrincipalDescriptor => p[n].signer.descriptor;
  const dek0 = generateResourceDEK();
  const dek1 = generateResourceDEK();

  const records: { bytes: Uint8Array; id: ControlRecordId }[] = [];
  const sign = (by: Name, seq: number, prev: ControlRecordId | null, body: ControlBody) =>
    signControlRecord(
      { resourceId: R, controlSeq: BigInt(seq), prevControlId: prev },
      body,
      p[by].signer,
    );
  const append = (by: Name, body: ControlBody): ControlRecordId => {
    const prev = records[records.length - 1]?.id ?? null;
    const s = sign(by, records.length, prev, body);
    records.push({ bytes: s.bytes, id: s.recordId });
    return s.recordId;
  };
  const grant = (subject: Name, abilities: bigint[], claimLimit?: bigint): ControlBody => ({
    type: "CAPABILITY_GRANT",
    subject: desc(subject),
    abilities,
    delegable: [],
    ...(claimLimit === undefined ? {} : { claimLimit }),
  });
  const frontier = (entries: [Name, bigint][]): ActorHave[] =>
    entries
      .map(([n, c]) => ({ principalId: id(n), contiguous: c, extras: [] }))
      .sort((a, b) => Buffer.compare(Buffer.from(a.principalId), Buffer.from(b.principalId)));

  append("owner", {
    type: "GENESIS",
    dataProfile: PROFILE,
    owner: desc("owner"),
    dekCommitment: dekCommitment(R, dataEpoch(0n), dek0),
    endpoints: [{ url: URL, priority: 0n }],
    coordinatorUrl: URL,
  });
  const c1 = append("owner", grant("bob", [1n, 2n, 3n, 6n]));
  const c2 = append("owner", grant("invite", [1n, 2n, 11n], 1n));
  const c3 = append("invite", {
    type: "CAPABILITY_CLAIM",
    invitationGrantId: c2,
    claimant: desc("carol"),
    abilities: [1n, 2n],
  });
  const c4 = append("owner", grant("dave", [1n]));
  const c5 = append("owner", { type: "CAPABILITY_REVOKE", grantId: c4 });
  const c6 = append("owner", {
    type: "KEY_EPOCH",
    epoch: dataEpoch(1n),
    dekCommitment: dekCommitment(R, dataEpoch(1n), dek1),
    finalFrontier: frontier([["bob", 2n]]),
    reason: 1n,
  });

  const unit = (
    actor: Name,
    epoch: bigint,
    seq: bigint,
    prev: Uint8Array | null,
    head: ControlRecordId,
    plaintext: string,
    dek: ResourceDEK,
  ) =>
    sealDataUnit(
      {
        resourceId: R,
        dataEpoch: dataEpoch(epoch),
        actorSeq: actorSequence(seq),
        // biome-ignore lint/suspicious/noExplicitAny: a DataUnitId from a unit ID.
        prevDataUnitId: prev as any,
        controlHead: head,
      },
      text(plaintext),
      dek,
      p[actor].signer,
    );
  const u1 = unit("bob", 0n, 1n, null, c1, "unit 1 from bob", dek0);
  const u2 = unit("bob", 0n, 2n, u1.unitId, c3, "unit 2 from bob", dek0);
  const u3 = unit("carol", 1n, 1n, null, c6, "unit 1 from carol", dek1);
  const u4 = unit("bob", 1n, 3n, u2.unitId, c6, "unit 3 from bob", dek1);
  const units: [string, typeof u1, number, string][] = [
    ["u1", u1, 0, "unit 1 from bob"],
    ["u2", u2, 0, "unit 2 from bob"],
    ["u3", u3, 1, "unit 1 from carol"],
    ["u4", u4, 1, "unit 3 from bob"],
  ];
  const pkg = (
    sender: Name,
    recipient: Name,
    epoch: bigint,
    head: ControlRecordId,
    dek: ResourceDEK,
  ) =>
    sealKeyPackage({
      resourceId: R,
      epoch: dataEpoch(epoch),
      controlHead: head,
      recipient: desc(recipient),
      dek,
      signer: p[sender].signer,
    });
  const snapshot = (
    publisher: Name,
    epoch: bigint,
    seq: bigint,
    head: ControlRecordId,
    f: ActorHave[],
    plaintext: string,
    dek: ResourceDEK,
  ) =>
    sealSnapshot(
      {
        resourceId: R,
        dataEpoch: dataEpoch(epoch),
        snapshotSeq: seq,
        controlHead: head,
        frontier: f,
      },
      text(plaintext),
      dek,
      p[publisher].signer,
    );

  const packages: [string, Uint8Array, Name, number][] = [
    ["kp_bob_e0", (await pkg("owner", "bob", 0n, c1, dek0)).bytes, "bob", 0],
    ["kp_invite_e0", (await pkg("owner", "invite", 0n, c2, dek0)).bytes, "invite", 0],
    ["kp_bob_e1", (await pkg("owner", "bob", 1n, c6, dek1)).bytes, "bob", 1],
    ["kp_carol_e1", (await pkg("bob", "carol", 1n, c6, dek1)).bytes, "carol", 1],
  ];
  const s1 = snapshot(
    "bob",
    1n,
    1n,
    c6,
    frontier([
      ["bob", 3n],
      ["carol", 1n],
    ]),
    "snapshot 1",
    dek1,
  );

  // Wire messages.
  const helloBody = {
    wireProfiles: ["LFCP-WIRE-01"],
    principal: desc("bob"),
    clientNonce: rnd(16),
  };
  const challengeBody = {
    wireProfile: "LFCP-WIRE-01",
    serverNonce: rnd(16),
    sessionId: rnd(16),
    serverId: rnd(32),
  };
  const proof = signAuthProof(
    {
      sessionId: challengeBody.sessionId,
      clientNonce: helloBody.clientNonce,
      serverNonce: challengeBody.serverNonce,
      serverId: challengeBody.serverId,
      principalId: id("bob"),
    },
    p.bob.signer,
  );
  const message = (type: string, body: unknown): Uint8Array =>
    encodeMessage({ type, messageId: rnd(16), body } as unknown as AnyMessage);
  const messages: [string, Uint8Array][] = [
    ["HELLO", message("HELLO", helloBody)],
    ["CHALLENGE", message("CHALLENGE", challengeBody)],
    ["AUTH", message("AUTH", { proof })],
    [
      "READY",
      message("READY", {
        wireProfile: "LFCP-WIRE-01",
        serverId: challengeBody.serverId,
        maxMessageBytes: 8388608n,
        durability: 2n,
        heartbeatMs: 30000n,
        extensions: [],
      }),
    ],
    [
      "RESOURCE_OPEN",
      message("RESOURCE_OPEN", {
        resourceId: R,
        heads: [{ seq: 6n, recordId: c6 }],
        haves: [
          { principalId: id("bob"), contiguous: 3n },
          { principalId: id("carol"), contiguous: 1n },
        ],
        flags: 3n,
      }),
    ],
    [
      "CONTROL_BATCH",
      message("CONTROL_BATCH", { resourceId: R, objects: records.map((r) => r.bytes) }),
    ],
    ["DATA_BATCH", message("DATA_BATCH", { resourceId: R, objects: units.map((u) => u[1].bytes) })],
    [
      "KEY_PACKAGE_BATCH",
      message("KEY_PACKAGE_BATCH", { resourceId: R, objects: packages.map((k) => k[1]) }),
    ],
    ["SNAPSHOT", message("SNAPSHOT", { resourceId: R, snapshot: s1.bytes })],
    [
      "ACK",
      message("ACK", {
        requestType: 33n,
        objectIds: units.map((u) => hash32(u[1].unitId)),
        durable: true,
      }),
    ],
    ["NACK", message("NACK", { code: 10n, details: Uint8Array.from(c6) })],
    ["ERROR", message("ERROR", { code: 3n })],
  ];

  // Negatives.
  const tampered = Uint8Array.from(u1.bytes);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
  const u4b = unit("bob", 1n, 3n, u2.unitId, c6, "a different unit 3", dek1);
  const negatives = [
    { name: "unit_tampered", kind: "unit", bytes: toHex(tampered), expect: "INVALID_SIGNATURE" },
    {
      name: "unit_unauthorized",
      kind: "unit",
      bytes: toHex(unit("dave", 0n, 1n, null, c4, "dave", dek0).bytes),
      expect: "AUTHORIZATION_FAILED",
    },
    {
      name: "unit_stale",
      kind: "unit",
      bytes: toHex(unit("bob", 0n, 7n, u2.unitId, c3, "stale", dek0).bytes),
      expect: "STALE_DATA_EPOCH",
    },
    {
      name: "unit_unknown_epoch",
      kind: "unit",
      bytes: toHex(unit("bob", 5n, 8n, u4.unitId, c6, "future", dek1).bytes),
      expect: "MISSING_DEPENDENCY",
    },
    {
      name: "unit_aead",
      kind: "unit",
      bytes: toHex(unit("bob", 1n, 9n, u4.unitId, c6, "wrong key", generateResourceDEK()).bytes),
      expect: "AEAD",
    },
    {
      name: "unit_equivocation",
      kind: "unit_pair",
      pair: [toHex(u4.bytes), toHex(u4b.bytes)],
      expect: "ACTOR_EQUIVOCATION",
    },
    {
      name: "record_unauthorized",
      kind: "record",
      bytes: toHex(sign("bob", 7, c6, grant("dave", [1n])).bytes),
      expect: "AUTHORIZATION_FAILED",
    },
    {
      name: "record_claim_used",
      kind: "record",
      bytes: toHex(
        sign("invite", 7, c6, {
          type: "CAPABILITY_CLAIM",
          invitationGrantId: c2,
          claimant: desc("dave"),
          abilities: [1n],
        }).bytes,
      ),
      expect: "AUTHORIZATION_FAILED",
    },
    {
      name: "record_fork",
      kind: "record",
      bytes: toHex(sign("owner", 6, c5, grant("dave", [1n])).bytes),
      expect: "CONTROL_CONFLICT",
    },
    {
      name: "kp_unauthorized",
      kind: "key_package",
      bytes: toHex((await pkg("carol", "bob", 1n, c6, dek1)).bytes),
      expect: "AUTHORIZATION_FAILED",
    },
    {
      name: "snapshot_unauthorized",
      kind: "snapshot",
      bytes: toHex(snapshot("carol", 1n, 1n, c6, frontier([["carol", 1n]]), "carol", dek1).bytes),
      expect: "AUTHORIZATION_FAILED",
    },
    {
      name: "snapshot_beyond_cutoff",
      kind: "snapshot",
      bytes: toHex(snapshot("bob", 0n, 2n, c6, frontier([["bob", 3n]]), "too much", dek0).bytes),
      expect: "STALE_DATA_EPOCH",
    },
  ];

  const chain = validateControlChain(records.map((r) => r.bytes));
  if (chain.kind !== "linear") throw new Error(`own chain: ${chain.kind}`);
  const bundle = {
    format: FORMAT,
    producer: "ts",
    resource_id: toHex(R),
    principals: Object.fromEntries(
      PRINCIPALS.map((n) => [
        n,
        {
          descriptor: toHex(encodePrincipalDescriptor(desc(n))),
          ed25519_seed: toHex(p[n].seed),
          x25519_private: toHex(p[n].x25519),
        },
      ]),
    ),
    control: {
      records: records.map((r) => toHex(r.bytes)),
      expect: {
        ...(controlExpect(chain.state, (pid) => nameOf(p, pid)) as Record<string, Json>),
        abilities: abilitiesAt(chain.state, Object.fromEntries(PRINCIPALS.map((n) => [n, id(n)]))),
      },
    },
    units: units.map(([name, u, epoch, plaintext]) => ({
      name,
      bytes: toHex(u.bytes),
      epoch,
      plaintext: toHex(text(plaintext)),
    })),
    key_packages: packages.map(([name, bytes, recipient, epoch]) => ({
      name,
      bytes: toHex(bytes),
      recipient,
      epoch,
    })),
    snapshots: [
      { name: "s1", bytes: toHex(s1.bytes), epoch: 1, plaintext: toHex(text("snapshot 1")) },
    ],
    messages: messages.map(([name, bytes]) => ({ name, bytes: toHex(bytes) })),
    negatives,
    shared_objects: produceSharedObjects(R, (n) => id(n)),
  };
  writeFileSync(join(dir, "bundle.json"), JSON.stringify(bundle, null, 2));
}

function nameOf(p: Record<string, Party>, pid: Uint8Array): string {
  const hex = toHex(pid);
  return (
    Object.entries(p).find(
      ([, party]) => toHex(party.signer.descriptor.principalId) === hex,
    )?.[0] ?? hex
  );
}

/** The Control semantics a consumer must derive, in the shared format. */
function controlExpect(state: ControlState, name: (pid: Uint8Array) => string): Json {
  const abilities: Record<string, number[]> = {};
  for (const n of PRINCIPALS) abilities[n] = [];
  const dekCommitments: Record<string, string> = {};
  const closed: Record<string, Json> = {};
  for (const [epoch, history] of state.epochs) {
    dekCommitments[epoch] = toHex(history.dekCommitment);
    if (history.finalFrontier !== null)
      closed[epoch] = history.finalFrontier.map((a) => ({
        principal: name(a.principalId),
        contiguous: Number(a.contiguous),
        extra: a.extras.map(([s, e]) => [Number(s), Number(e)]),
      }));
  }
  return {
    head_seq: Number(state.seq),
    head_id: toHex(state.head),
    owner: name(state.owner.principalId),
    current_epoch: Number(state.epoch.epoch),
    abilities,
    dek_commitments: dekCommitments,
    closed_frontiers: closed,
  };
}

/** Each named principal's abilities at the head, sorted. */
function abilitiesAt(
  state: ControlState,
  ids: Record<string, Uint8Array>,
): Record<string, number[]> {
  return Object.fromEntries(
    Object.entries(ids).map(([n, pid]) => [
      n,
      abilitiesOf(state, pid as PrincipalId)
        .map(Number)
        .sort((a, b) => a - b),
    ]),
  );
}

/** Canonical JSON text: keys sorted at every level. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The shared logical view: the root (winning values) and the conflicted scalar fields. */
function view(replica: SharedObjectsReplica): Json {
  const conflicts: Record<string, Record<string, Json[]>> = {};
  for (const [obj, fields] of Object.entries(replica.conflicts())) {
    for (const [field, values] of Object.entries(fields)) {
      if (!SCALAR_FIELDS.includes(field)) continue;
      conflicts[obj] ??= {};
      (conflicts[obj] as Record<string, Json[]>)[field] = [...values].sort((a, b) =>
        JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0,
      );
    }
  }
  return { root: replica.root(), conflicts };
}

/**
 * `[1, bytes]` as deterministic CBOR without checking the bytes: frameChange
 * refuses a change whose checksum does not match, which is what a negative
 * case needs to carry.
 */
function frameRaw(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  const head =
    n < 24
      ? [0x40 + n]
      : n < 0x100
        ? [0x58, n]
        : n < 0x10000
          ? [0x59, n >> 8, n & 0xff]
          : [0x5a, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return Uint8Array.from([0x82, 0x01, ...head, ...bytes]);
}

/**
 * The Shared Objects history, as the Rust producer writes it except where
 * sdk-ts has no public way to write the state: no unknown Task field, no
 * object of an unknown type, no profile-invalid state (those come only from
 * the Rust producer).
 */
function produceSharedObjects(R: ResourceId, id: (n: Name) => PrincipalId): unknown {
  const { replica: owner } = SharedObjectsReplica.create({ resource: R, principal: id("owner") });
  const t1 = generateObjectId();
  const t2 = generateObjectId();
  owner.apply(createTask({ id: t1, title: "Plan the release", createdBy: id("owner") }).intent);
  owner.apply(createTask({ id: t2, title: "Draft notes", createdBy: id("owner") }).intent);
  owner.apply(
    createTask({ id: generateObjectId(), title: "Long notes ".repeat(300), createdBy: id("owner") })
      .intent,
  );
  const fork = (n: Name) =>
    SharedObjectsReplica.fromChanges(owner.changes(), { resource: R, principal: id(n) }).replica;
  const bob = fork("bob");
  const carol = fork("carol");
  const task = (r: SharedObjectsReplica, t: string) => {
    const v = r.task(t)?.task;
    if (v === undefined) throw new Error(`no task ${t}`);
    return v;
  };
  // Another first change by bob on the same state: equivocation (§26.2).
  const bobTwin = fork("bob");
  const twin = bobTwin.apply(setTitle(task(bobTwin, t1), "Plan the release (bob, twin)").intent);
  if (twin === null) throw new Error("the twin made no change");
  const local: LocalChange[] = [];
  const keep = (c: LocalChange | null) => {
    if (c !== null) local.push(c);
  };
  const bobChanges = new Set<string>();
  const keepBob = (c: LocalChange | null) => {
    if (c !== null) {
      bobChanges.add(c.hash);
      local.push(c);
    }
  };
  keepBob(bob.apply(setTitle(task(bob, t1), "Plan the release (bob)").intent));
  keep(carol.apply(setTitle(task(carol, t1), "Plan the release (carol)").intent));
  keepBob(bob.apply(addTag(task(bob, t1), "urgent").intent));
  keep(carol.apply(addTag(task(carol, t1), "later").intent));
  owner.apply(deleteTask(task(owner, t2)).intent);
  keep(carol.apply(setTitle(task(carol, t2), "Draft notes, edited").intent));
  // The owner takes bob's changes, removes bob's tag, then takes carol's:
  // the title conflict arrives last (sdk-ts refuses writes to an object
  // with a conflicted string field; see the compatibility report).
  for (const c of local.filter((c) => c.intent !== "" && bobChanges.has(c.hash)))
    owner.receive(c.plaintext);
  owner.apply(removeTag(task(owner, t1), "urgent").intent);
  for (const c of local.filter((c) => !bobChanges.has(c.hash))) owner.receive(c.plaintext);

  const actors = Object.fromEntries(
    (["owner", "bob", "carol"] as const).map((n) => [toHex(deriveActorId(R, id(n))), n]),
  );
  const changes = owner.changes();
  const chunkTypes = [...new Set(changes.map((c) => c[8] as number))].sort();
  const entries = changes.map((c) => ({
    plaintext: toHex(frameChange(c)),
    signer: actors[unframeChange(frameChange(c)).actor],
  }));
  const firstBob = changes.find((c) => actors[unframeChange(frameChange(c)).actor] === "bob");
  if (firstBob === undefined) throw new Error("no change by bob");
  const corrupt = Uint8Array.from(firstBob);
  corrupt[4] = (corrupt[4] as number) ^ 0xff;
  return {
    changes: entries,
    change_chunk_types: chunkTypes,
    snapshot: toHex(owner.snapshot()),
    expect: view(owner),
    negatives: [
      {
        name: "change_signer",
        kind: "change",
        plaintext: toHex(frameChange(firstBob)),
        signer: "carol",
        expect: "CHANGE_ACTOR_MISMATCH",
      },
      {
        name: "change_checksum",
        kind: "change",
        plaintext: toHex(frameRaw(corrupt)),
        signer: "bob",
        expect: "INVALID_AUTOMERGE_BYTES",
      },
      {
        name: "snapshot_change_chunk",
        kind: "snapshot",
        // [1, change]: the framing a Snapshot uses, around a change chunk.
        plaintext: toHex(frameChange(firstBob)),
        expect: "INVALID_AUTOMERGE_BYTES",
      },
      {
        name: "change_equivocation",
        kind: "change",
        plaintext: toHex(twin.plaintext),
        signer: "bob",
        // SHARED-OBJECTS-PROFILE-01 §14.1 (baseline.9, POST-001): held, not refused.
        expect: "HELD",
      },
    ],
  };
}

// ---------------------------------------------------------------- consume

type Result = "PASS" | "FAIL";
interface Check {
  id: string;
  category: string;
  result: Result;
  detail: string;
}

function ensure(condition: boolean, detail: () => string): string | null {
  return condition ? null : detail();
}

/** The §62 code of a thrown error, or "AEAD" for a client-local AEAD failure. */
function codeOf(e: unknown): string {
  if (e instanceof LfcpError) {
    if (e.code === "AEAD_AUTHENTICATION_FAILED") return "AEAD";
    return e.code;
  }
  return `UNMAPPED:${e instanceof Error ? e.message : String(e)}`;
}

async function consume(dir: string): Promise<void> {
  const bundle: Bundle = JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8"));
  if (bundle.format !== FORMAT) throw new Error(`bundle format ${bundle.format}`);
  const checks: Check[] = [];
  const check = async (
    id: string,
    category: string,
    run: () => Promise<string | null> | string | null,
  ) => {
    let detail: string | null;
    try {
      detail = await run();
    } catch (e) {
      detail = `threw ${codeOf(e)}`;
    }
    checks.push({ id, category, result: detail === null ? "PASS" : "FAIL", detail: detail ?? "" });
  };
  const R = resourceId(fromHex(bundle.resource_id));

  // Principals.
  const parties: Record<string, Party> = {};
  for (const [name, entry] of Object.entries(bundle.principals) as [string, Bundle][]) {
    const k = party(fromHex(entry.ed25519_seed), fromHex(entry.x25519_private));
    parties[name] = k;
    await check(`principal.${name}`, "principal", () => {
      const d = decodePrincipalDescriptor(fromHex(entry.descriptor));
      return ensure(
        toHex(d.principalId) === toHex(k.signer.descriptor.principalId) &&
          toHex(d.ed25519PublicKey) === toHex(k.signer.descriptor.ed25519PublicKey) &&
          toHex(d.x25519PublicKey) === toHex(k.signer.descriptor.x25519PublicKey),
        () => "descriptor does not match its keys",
      );
    });
  }
  const ids = Object.fromEntries(
    Object.entries(parties).map(([n, k]) => [n, k.signer.descriptor.principalId]),
  );
  const name = (pid: Uint8Array) => nameOf(parties, pid);

  // Control.
  const records: Uint8Array[] = bundle.control.records.map((h: string) => fromHex(h));
  const chain = validateControlChain(records);
  await check("control.chain", "control", () =>
    ensure(
      chain.kind === "linear",
      () => `${chain.kind} ${"wireCode" in chain ? chain.wireCode : ""}`,
    ),
  );
  if (chain.kind !== "linear") throw new Error("the chain does not validate; nothing else can run");
  const view0 = { state: chain.state, stateAt: chain.stateAt };
  const expect = bundle.control.expect;
  const got = controlExpect(chain.state, name) as Record<string, Json>;
  got.abilities = abilitiesAt(chain.state, ids);
  await check("control.head", "control", () =>
    ensure(got.head_seq === expect.head_seq && got.head_id === expect.head_id, () =>
      canonical(got),
    ),
  );
  await check("control.owner", "control", () =>
    ensure(got.owner === expect.owner, () => String(got.owner)),
  );
  for (const n of Object.keys(parties))
    await check(`control.abilities.${n}`, "control", () => {
      const mine = (got.abilities as Record<string, number[]>)[n];
      return ensure(canonical(mine) === canonical(expect.abilities[n]), () => canonical(mine));
    });
  await check("control.epoch", "control", () =>
    ensure(got.current_epoch === expect.current_epoch, () => String(got.current_epoch)),
  );
  await check("control.dek_commitments", "control", () =>
    ensure(
      canonical(got.dek_commitments) === canonical(expect.dek_commitments),
      () => "commitments",
    ),
  );
  await check("control.cutoff", "control", () =>
    ensure(canonical(got.closed_frontiers) === canonical(expect.closed_frontiers), () =>
      canonical(got.closed_frontiers),
    ),
  );
  const resolvePrincipal = (pid: PrincipalId) => chain.state.principals.get(toHex(pid));

  // Key Packages.
  const deks = new Map<number, ResourceDEK>();
  for (const k of bundle.key_packages) {
    await check(`key_package.${k.name}`, "hpke", async () => {
      const parsed = parseKeyPackage(fromHex(k.bytes));
      const verdict = verifyKeyPackage(view0, parsed);
      if (verdict.kind !== "authorized") return verdict.wireCode;
      const commitment = chain.state.epochs.get(String(k.epoch))?.dekCommitment;
      if (commitment === undefined) return "no commitment";
      const recipient = parties[k.recipient] as Party;
      const dek = await openKeyPackage(
        parsed,
        { descriptor: recipient.signer.descriptor, agreement: recipient.agreement },
        commitment,
      );
      const known = deks.get(k.epoch);
      if (
        known !== undefined &&
        toHex(exportSecretKeyBytes(known)) !== toHex(exportSecretKeyBytes(dek))
      )
        return "packages disagree";
      deks.set(k.epoch, dek);
      return null;
    });
  }

  // Data Units.
  const openUnit = async (bytes: Uint8Array, seen = new InMemorySeenUnits()): Promise<string> => {
    const r = await checkDataUnit(view0, bytes, seen, { resolvePrincipal });
    if (r.kind === "rejected") return r.wireCode;
    if (r.kind === "equivocation") return r.wireCode;
    if (r.kind === "quarantined") return r.code;
    const p = r.parsed.payload;
    const dek = deks.get(Number(p.dataEpoch));
    if (dek === undefined) return "NO_DEK";
    try {
      decryptDataUnit(
        deriveActorDataKey(dek, p.resourceId, p.dataEpoch, p.actor),
        p.actorSeq,
        dataUnitAad(p),
        p.ciphertext,
      );
    } catch (e) {
      return codeOf(e);
    }
    return "ACCEPTED";
  };
  for (const u of bundle.units) {
    await check(`data_unit.${u.name}`, "data", async () => {
      const r = await checkDataUnit(view0, fromHex(u.bytes), new InMemorySeenUnits(), {
        resolvePrincipal,
      });
      if (r.kind !== "valid") return r.kind === "quarantined" ? r.code : r.wireCode;
      const p = r.parsed.payload;
      const dek = deks.get(u.epoch);
      if (dek === undefined) return "no DEK";
      const plain = decryptDataUnit(
        deriveActorDataKey(dek, p.resourceId, p.dataEpoch, p.actor),
        p.actorSeq,
        dataUnitAad(p),
        p.ciphertext,
      );
      return ensure(toHex(plain) === u.plaintext, () => "plaintext differs");
    });
  }

  // Snapshots.
  for (const s of bundle.snapshots) {
    await check(`snapshot.${s.name}`, "snapshot", () => {
      const r = checkSnapshot(view0, fromHex(s.bytes), { resolvePrincipal });
      if (r.kind !== "valid") return r.wireCode;
      const p = r.parsed.payload;
      const dek = deks.get(s.epoch);
      if (dek === undefined) return "no DEK";
      const plain = decryptSnapshot(
        deriveSnapshotKey(dek, p.resourceId, p.dataEpoch, p.publisher),
        p.snapshotSeq,
        snapshotAad(p),
        p.ciphertext,
      );
      return ensure(toHex(plain) === s.plaintext, () => "plaintext differs");
    });
  }

  // Messages.
  const decoded = new Map<string, AnyMessage>();
  for (const m of bundle.messages) {
    await check(`message.${m.name}`, "message", () => {
      const bytes = fromHex(m.bytes);
      const message = decodeMessage(bytes);
      decoded.set(m.name, message);
      return ensure(toHex(encodeMessage(message)) === m.bytes, () => "re-encoding differs");
    });
  }
  await check("message.AUTH.verify", "message", () => {
    // biome-ignore lint/suspicious/noExplicitAny: bodies by message type.
    const hello = decoded.get("HELLO")?.body as any;
    // biome-ignore lint/suspicious/noExplicitAny: bodies by message type.
    const challenge = decoded.get("CHALLENGE")?.body as any;
    // biome-ignore lint/suspicious/noExplicitAny: bodies by message type.
    const auth = decoded.get("AUTH")?.body as any;
    if (!hello || !challenge || !auth) return "missing handshake messages";
    const r = verifyAuthProof(
      auth.proof,
      {
        sessionId: challenge.sessionId,
        clientNonce: hello.clientNonce,
        serverNonce: challenge.serverNonce,
        serverId: challenge.serverId,
        principalId: hello.principal.principalId,
      },
      hello.principal,
    );
    return ensure(
      r.valid && toHex(hello.principal.principalId) === toHex(ids.bob as Uint8Array),
      () => JSON.stringify(r),
    );
  });

  // Negatives.
  for (const n of bundle.negatives) {
    await check(`negative.${n.name}`, "negative", async () => {
      let code: string;
      switch (n.kind) {
        case "unit":
          code = await openUnit(fromHex(n.bytes));
          break;
        case "unit_pair": {
          const seen = new InMemorySeenUnits();
          const first = await openUnit(fromHex(n.pair[0]), seen);
          code = first === "ACCEPTED" ? await openUnit(fromHex(n.pair[1]), seen) : first;
          break;
        }
        case "record": {
          const r = validateControlChain([...records, fromHex(n.bytes)]);
          code = r.kind === "linear" ? "ACCEPTED" : r.wireCode;
          break;
        }
        case "key_package": {
          const r = verifyKeyPackage(view0, parseKeyPackage(fromHex(n.bytes)));
          code = r.kind === "authorized" ? "ACCEPTED" : r.wireCode;
          break;
        }
        case "snapshot": {
          const r = checkSnapshot(view0, fromHex(n.bytes), { resolvePrincipal });
          code = r.kind === "valid" ? "ACCEPTED" : r.wireCode;
          break;
        }
        default:
          code = `UNKNOWN_KIND:${n.kind}`;
      }
      return ensure(code === n.expect, () => `got ${code}`);
    });
  }

  await consumeSharedObjects(bundle.shared_objects, R, ids, check);

  writeFileSync(
    join(dir, "results-ts.json"),
    JSON.stringify(
      { format: "lfcp-interop-results/1", consumer: "ts", producer: bundle.producer, checks },
      null,
      2,
    ),
  );
}

async function consumeSharedObjects(
  so: Bundle,
  R: ResourceId,
  ids: Record<string, Uint8Array>,
  check: (
    id: string,
    category: string,
    run: () => Promise<string | null> | string | null,
  ) => Promise<void>,
): Promise<void> {
  const reader = () => {
    const replica = SharedObjectsReplica.empty({ resource: R, principal: rnd(32) as PrincipalId });
    return new SharedObjectsDataProfile(replica);
  };
  /** Apply framed changes with their signers through the §11 actor check. */
  const applyAll = (profile: SharedObjectsDataProfile, changes: Bundle[]) => {
    let held = false;
    for (const [i, c] of changes.entries()) {
      const plaintext = fromHex(c.plaintext);
      const change = profile
        .codecFor({ resourceId: R, actor: ids[c.signer] as PrincipalId })
        .decode(plaintext);
      const r = profile.apply({ unitId: rnd(32) as never }, change);
      if (r.pending) throw new Error(`change ${i} has missing dependencies`);
      held = r.held !== undefined;
    }
    return held;
  };
  const expect = canonical(so.expect);

  const profile = reader();
  await check("shared_objects.changes", "shared_objects", () => {
    applyAll(profile, so.changes);
    const got = canonical(view(profile.replica));
    return ensure(got === expect, () => `view differs: ${got}`);
  });
  await check("shared_objects.validate", "shared_objects", () => {
    const v = profile.replica.validate();
    return ensure(v.valid, () => JSON.stringify(v.problems));
  });
  await check("shared_objects.snapshot", "shared_objects", () => {
    const loaded = SharedObjectsReplica.fromSnapshot(fromHex(so.snapshot), {
      resource: R,
      principal: rnd(32) as PrincipalId,
    });
    const got = canonical(view(loaded));
    return ensure(got === expect, () => `view differs: ${got}`);
  });

  for (const n of so.negatives) {
    await check(`shared_objects.negative.${n.name}`, "shared_objects", () => {
      let got: string | string[][];
      switch (n.kind) {
        case "change": {
          const p = reader();
          applyAll(p, so.changes);
          try {
            got = applyAll(p, [n]) ? "HELD" : "ACCEPTED";
          } catch (e) {
            const err = e as { diagnostic?: string; code?: string };
            got = err.diagnostic ?? err.code ?? String(e);
          }
          return ensure(got === n.expect, () => `got ${got}`);
        }
        case "snapshot":
          try {
            unframeSnapshot(fromHex(n.plaintext));
            got = "ACCEPTED";
          } catch (e) {
            got = (e as { diagnostic?: string }).diagnostic ?? String(e);
          }
          return ensure(got === n.expect, () => `got ${got}`);
        case "state": {
          const p = reader();
          applyAll(p, so.changes);
          applyAll(p, n.changes);
          const v = p.replica.validate();
          const all = [...v.problems, ...[...v.objects.values()].flat()];
          // validate().problems already includes the objects' problems.
          const mine = [...new Set(all.map((x) => JSON.stringify([x.pointer, x.diagnostic])))]
            .map((x) => JSON.parse(x) as string[])
            .sort();
          const want = n.expect.map((x: Bundle) => [x.pointer, x.diagnostic]).sort();
          return ensure(canonical(mine) === canonical(want), () => `got ${canonical(mine)}`);
        }
        default:
          return `unknown kind ${n.kind}`;
      }
    });
  }
}

// ---------------------------------------------------------------- shared sections
//
// The shared sections exchange (LFCP-02-023, LFCP-02-024), bundle
// `lfcp-interop-sections/1` in `<dir>/sections.json`, as the Rust adapter
// writes it (sdk-rs crates/lfcp/examples/interop_sections.rs):
//
//   { format, producer, scenarios: [{ id, description, resource_id,
//     principals: { <name>: <principal hex> },
//     changes: [{ signer: <name>, framed_plaintext: <hex> }],
//     expected: { classification, tree: [[id, parent, depth, kind]], hidden,
//       recovery: { <node>: <fact> }, invalid: { <node>: <diagnostic> },
//       collisions, refused: { <change hash>: <code> }, waiting,
//       retained_concurrent_edits, texts: { <node>: <text> },
//       titles: { <task>: <title> } } }] }
//
// A consumer replays each scenario's changes through its section admission,
// in order and in reverse with duplicates, derives the same summary and
// writes `<dir>/sections-results-<consumer>.json` ({ consumer, checks }),
// one check `sections.<scenario id>` per scenario.
//
// The TypeScript side is sections-ts.ts: sdk-ts writes its scenarios through
// its section writer and consumes the other SDK's through its section
// admission (LFCP-02-023).

const [command, dir] = process.argv.slice(2);
if (command === "produce" && dir !== undefined) await produce(dir);
else if (command === "consume" && dir !== undefined) await consume(dir);
else if (command === "produce-sections" && dir !== undefined) await produceSections(dir);
else if (command === "consume-sections" && dir !== undefined) await consumeSections(dir);
else {
  process.stderr.write(
    "usage: ts-adapter (produce|consume|produce-sections|consume-sections) <dir>\n",
  );
  process.exitCode = 2;
}
