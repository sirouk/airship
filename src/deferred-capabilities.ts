/**
 * Airship's capability pack is a genuine dynamic boundary. The interactive
 * shell stays small; the first advanced surface or agent turn downloads one
 * cacheable pack instead of dozens of individually compressed fragments.
 *
 * Keep this module free of side effects. Its exports are the reviewed lazy
 * capabilities used by route wrappers and runtime coordinators.
 */
export { ChutesAttestationEvidenceClient } from "./attestation/provider-client";
export { createIntelDcapVerifierPort } from "./attestation/dcap/intel-dcap";
export { createIntelDcapQvlVerifierPort } from "./attestation/dcap/intel-dcap-qvl";
export { loadChutesAccountSnapshot } from "./billing/client";
export { auditSessionHistory } from "./core/session-audit";
export { CanvasMemoryGraphSurface } from "./memory-graph/canvas-renderer";
export { EncryptedObjectJournalBackend } from "./storage/encrypted-object-journal";
export { EncryptedProfileCatalogStore } from "./profiles/persistence";
export { runObjectStoreConformance } from "./storage/conformance";
export { S3ObjectStore } from "./storage/s3-object-store";
export {
  GOOGLE_ACCOUNT_SCOPES,
  GOOGLE_DRIVE_FILE_SCOPE,
  GoogleIdentityServicesAuthorizer,
  MemoryOnlyGoogleAccessTokenProvider,
  readGoogleAccountIdentity,
} from "./storage/google-drive-auth";
export { GoogleDriveObjectStore } from "./storage/google-drive-object-store";
export { GoogleDriveWorkspaceManager } from "./storage/google-drive-workspace";
export {
  LocalDeviceObjectStore,
  openLocalDeviceObjectStore,
  requestPersistentLocalDeviceStorage,
} from "./storage/local-device-object-store";
export {
  importLocalDeviceWorkspaceRecoveryKey,
  openLocalDeviceWorkspaceKey,
  prepareLocalDeviceWorkspaceKeyEnrollment,
} from "./storage/local-device-keyring";
export { createClientCiphertextCache } from "./storage/client-ciphertext-cache";
export { CiphertextCachingObjectStore } from "./storage/caching-object-store";
export { AccessView } from "./ui/access-view";
export { AttestationsView } from "./ui/attestations-view";
export { BillingView } from "./ui/billing-view";
export { GoogleDriveSetup } from "./ui/google-drive-setup";
export { LocalLabSetup } from "./ui/local-lab-setup";
export {
  describeSessionPresentationFault,
  presentSessionMessages,
} from "./ui/chat/session-message-presentation";
export { ContextView } from "./ui/context-view";
export {
  LocalLabRecoveryMaterial,
  createLocalLabConfigureRequest,
  importLocalLabRecoveryKey,
} from "./vault/local-lab";
export {
  WorkspaceRecoveryMaterial,
  importWorkspaceRecoveryKey,
} from "./vault/recovery";
export {
  migrateJournalState,
  migrateProfileCatalogState,
  migrateWorkspaceState,
  reconcileAdoptedProfileCatalog,
} from "./vault/runtime-adoption";
export { EncryptedObjectWorkspace } from "./vault/encrypted-workspace";
export { VaultContextFabricPort } from "./vault/context-fabric-port";
export {
  openLocalDeviceVault,
  restoreLocalDeviceVaultBackup,
} from "./vault/local-device";
export { SourcesView } from "./ui/sources-view";
