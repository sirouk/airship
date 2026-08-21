import { describe, expect, it } from "vitest";
import {
  validateVaultS3Configuration,
  vaultProviderRequirements,
  VaultConfigurationError,
  type VaultS3ConfigurationInput,
} from "./config";

describe("vault S3 configuration", () => {
  it("canonicalizes no values and exposes exact network, CORS, IAM, and lifecycle requirements", () => {
    const config = validateVaultS3Configuration(productionConfig());
    const requirements = vaultProviderRequirements(config);

    expect(config).toMatchObject({
      endpoint: "https://s3.us-east-1.amazonaws.com",
      region: "us-east-1",
      bucket: "airship-private",
      namespace: "airship/v1/subject:abc-123",
      probePrefix: ".airship-probes/v1",
      forcePathStyle: false,
    });
    expect(requirements.networkOrigins).toEqual([
      "https://airship-private.s3.us-east-1.amazonaws.com",
      "https://cognito-identity.us-east-1.amazonaws.com",
      "https://issuer.example",
    ]);
    expect(requirements.cors.allowedRequestHeaders).toContain("If-Match");
    expect(requirements.cors.exposedResponseHeaders).toContain("ETag");
    expect(requirements.authorization).toMatchObject({
      listPrefix: "airship/v1/subject:abc-123/*",
      objectPrefix: "airship/v1/subject:abc-123/*",
    });
    expect(requirements.probeLifecycle).toMatchObject({
      logicalPrefix: "airship/v1/subject:abc-123/.airship-probes/v1",
      deletionAvailableInRuntime: false,
    });
  });

  it.each([
    ["http production endpoint", { endpoint: "http://s3.example" }, "endpoint-invalid"],
    ["endpoint path", { endpoint: "https://s3.example/base" }, "endpoint-invalid"],
    ["endpoint secret", { endpoint: "https://user:secret@s3.example" }, "endpoint-invalid"],
    ["uppercase region", { region: "US-EAST-1" }, "region-invalid"],
    ["IP bucket", { bucket: "192.168.1.1" }, "bucket-invalid"],
    ["dotted virtual host", { bucket: "private.bucket" }, "bucket-invalid"],
    ["namespace traversal", { namespace: "airship/../other" }, "namespace-invalid"],
    ["namespace alias", { namespace: "airship//other" }, "namespace-invalid"],
    ["encoded namespace", { namespace: "airship/%2e%2e/other" }, "namespace-invalid"],
    ["probe traversal", { probePrefix: "probe/../other" }, "probe-prefix-invalid"],
  ])("rejects %s", (_label, override, code) => {
    expect(() => validateVaultS3Configuration({ ...productionConfig(), ...override })).toThrowError(
      expect.objectContaining({ name: "VaultConfigurationError", code }),
    );
  });

  it("permits an explicit loopback S3-compatible development service without pretending it is production", () => {
    const config = validateVaultS3Configuration({
      mode: "local-development",
      endpoint: "http://127.0.0.1:9000",
      region: "auto",
      bucket: "airship-dev",
      namespace: "users/test",
      credentialSource: {
        kind: "local-development",
        displayName: "Local MinIO lab",
        authorityOrigins: [],
      },
    });
    expect(config).toMatchObject({ forcePathStyle: true, endpoint: "http://127.0.0.1:9000" });

    expect(() => validateVaultS3Configuration({
      ...productionConfig(),
      mode: "local-development",
      credentialSource: { kind: "local-development", displayName: "Lab", authorityOrigins: [] },
    })).toThrow(VaultConfigurationError);
  });

  it("requires an explicit temporary authority for production and refuses local credential labeling", () => {
    expect(() => validateVaultS3Configuration({
      ...productionConfig(),
      credentialSource: { kind: "custom-temporary", displayName: "No origin", authorityOrigins: [] },
    })).toThrow("authority origin");
    expect(() => validateVaultS3Configuration({
      ...productionConfig(),
      credentialSource: { kind: "local-development", displayName: "Static keys", authorityOrigins: [] },
    })).toThrow("temporary authenticated");
  });
});

function productionConfig(): VaultS3ConfigurationInput {
  return {
    mode: "strict-production",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    bucket: "airship-private",
    namespace: "airship/v1/subject:abc-123",
    forcePathStyle: false,
    credentialSource: {
      kind: "cognito-identity",
      displayName: "Cognito Identity + OIDC",
      authorityOrigins: [
        "https://issuer.example",
        "https://cognito-identity.us-east-1.amazonaws.com",
      ],
    },
  };
}
