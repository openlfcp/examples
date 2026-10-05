import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  fromBase64url,
  fromHex,
  type PrincipalId,
  principalId,
  type ResourceId,
  resourceId,
  toBase64url,
  toHex,
} from "@openlfcp/core";
import {
  type AgreementKeyPair,
  exportSecretKeyBytes,
  generateAgreementKeyPair,
  generateSigningKeyPair,
  importAgreementKey,
  importSigningKey,
} from "@openlfcp/crypto";
import { principalKeySecretRef } from "@openlfcp/storage";
import { FileSecretStore, SqliteLfcpStorage } from "@openlfcp/storage-node";
import { principalDescriptorFromKeys, type Signer } from "@openlfcp/wire";

/**
 * A CLI home directory (default ~/.openlfcp-cli, or --home):
 *
 * - lfcp.sqlite: SqliteLfcpStorage (LFCP-035): Control Chains, Data Units,
 *   Key Packages, the outbound queue, profile checkpoints (the decrypted
 *   Task state, so the file is 0600);
 * - secrets/: FileSecretStore: the Principal's private keys and the
 *   Resource DEKs (plaintext files, 0600, in a 0700 directory);
 * - config.json: public settings only: the local Principal's ID and the
 *   current Resource.
 */

export interface Config {
  /** Hex Principal ID of the local Principal; its keys are in the secret store. */
  principal?: string;
  /** Hex ID of the Resource commands use when --resource is not given. */
  current?: string;
}

/** The plaintext-on-disk caveat of FileSecretStore, shown when a home first stores a secret. */
export const SECRETS_CAVEAT =
  "Note: private keys and Resource keys are stored in PLAINTEXT on disk under <home>/secrets " +
  "(files 0600, directory 0700). Anyone who can read them as you, as root or from a backup has " +
  "the keys. This is MVP reference software.";

export const defaultHome = (env: Readonly<Record<string, string | undefined>>): string =>
  env.LFCP_TODO_HOME ?? join(homedir(), ".openlfcp-cli");

export class Home {
  readonly storage: SqliteLfcpStorage;
  readonly secrets: FileSecretStore;
  readonly #configPath: string;
  #config: Config;

  private constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The database holds the decrypted Shared Objects state (profile
    // checkpoints): readable by this user only, like the secrets.
    const db = join(dir, "lfcp.sqlite");
    this.storage = SqliteLfcpStorage.open(db);
    for (const f of [db, `${db}-wal`, `${db}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
    this.secrets = new FileSecretStore(join(dir, "secrets"));
    this.#configPath = join(dir, "config.json");
    this.#config = existsSync(this.#configPath)
      ? (JSON.parse(readFileSync(this.#configPath, "utf8")) as Config)
      : {};
  }

  static open(dir: string): Home {
    return new Home(dir);
  }

  get config(): Readonly<Config> {
    return this.#config;
  }

  /** Writes config.json atomically (it holds no secrets). */
  update(change: Partial<Config>): void {
    this.#config = { ...this.#config, ...change };
    const tmp = `${this.#configPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#config, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.#configPath);
  }

  close(): void {
    this.storage.close();
  }

  /** Creates the local Principal: fresh independent Ed25519 and X25519 keys, into the secret store first. */
  async createPrincipal(): Promise<PrincipalId> {
    if (this.#config.principal !== undefined)
      throw new CliError("this home already has a Principal (principal show)");
    const signing = generateSigningKeyPair();
    const agreement = generateAgreementKeyPair();
    const id = principalDescriptorFromKeys(signing, agreement).principalId;
    await this.secrets.put(principalKeySecretRef(id, "signing"), exportSecretKeyBytes(signing));
    await this.secrets.put(principalKeySecretRef(id, "agreement"), exportSecretKeyBytes(agreement));
    this.update({ principal: toHex(id) });
    return id;
  }

  /** The local Principal's signer and agreement key, from the secret store. */
  async principal(): Promise<{ signer: Signer; agreement: AgreementKeyPair }> {
    const hex = this.#config.principal;
    if (hex === undefined) throw new CliError("no Principal yet: run `principal create` first");
    const id = principalId(fromHex(hex));
    const signingBytes = await this.secrets.get(principalKeySecretRef(id, "signing"));
    const agreementBytes = await this.secrets.get(principalKeySecretRef(id, "agreement"));
    if (signingBytes === undefined || agreementBytes === undefined)
      throw new CliError("the Principal's keys are missing from the secret store");
    const key = importSigningKey(signingBytes);
    const agreement = importAgreementKey(agreementBytes);
    signingBytes.fill(0);
    agreementBytes.fill(0);
    const descriptor = principalDescriptorFromKeys(key, agreement);
    if (toHex(descriptor.principalId) !== hex)
      throw new CliError("the stored keys do not belong to the configured Principal");
    return { signer: { key, descriptor }, agreement };
  }

  /** The Resource a command acts on: --resource (base64url or hex), else the current one. */
  resource(arg: string | undefined): ResourceId {
    const text = arg ?? this.#config.current;
    if (text === undefined)
      throw new CliError("no Resource selected: create or join one, or pass --resource");
    return parseResourceId(text);
  }
}

/** An expected failure, shown as one line without a stack. */
export class CliError extends Error {}

/** A Resource ID as given: 43-character base64url or 64-character hex. */
export function parseResourceId(text: string): ResourceId {
  try {
    if (/^[0-9a-f]{64}$/i.test(text)) return resourceId(fromHex(text.toLowerCase()));
    return resourceId(fromBase64url(text));
  } catch {
    throw new CliError("not a Resource ID (base64url or hex of 32 bytes)");
  }
}

/** How the CLI shows a Resource ID. */
export const showResource = (id: ResourceId): string => toBase64url(id);
