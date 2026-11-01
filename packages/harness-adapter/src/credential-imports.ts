import type {
  CredentialImportRecord,
  CredentialOtherLogin,
  CredentialSource,
} from "@codexhost/shared-contracts";

/** Backend-only transfer. Never serialize this object into a Desktop response or log. */
export interface HarnessCredentialTransfer {
  source: CredentialSource;
  oauth: { access: string; refresh: string; expires: number; accountId?: string };
}
export interface HarnessCredentialExport {
  /** Re-read on every request; source IDs must change when the native account changes. */
  read(): Promise<HarnessCredentialTransfer[]>;
}
export interface HarnessCredentialImports {
  providers: readonly CredentialSource["provider"][];
  list(): Promise<CredentialImportRecord[]>;
  /** Read-only summary of the target's other logins (Provider and type only); no values. */
  listOthers?(): Promise<CredentialOtherLogin[]>;
  add(name: string, credential: HarnessCredentialTransfer): Promise<void>;
  reimport(name: string, credential: HarnessCredentialTransfer): Promise<void>;
  remove(name: string): Promise<void>;
}
