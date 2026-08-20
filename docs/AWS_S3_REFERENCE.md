# AWS S3 browser reference deployment

Status: executable adapter; a live account deployment and browser-origin
conformance report are still required.

This is Airship's production semantic baseline while Shelby's delegated
authorization and vault-head contract are being designed. It introduces no
Airship application server: the browser obtains an OIDC ID token from the
selected identity service, exchanges it directly with Cognito Identity, and
sends ciphertext directly to one S3 bucket.

## Public-client flow

```text
OIDC Authorization Code + PKCE
  -> ID token in page memory
  -> Cognito Identity GetId
  -> Cognito Identity GetCredentialsForIdentity
  -> one-hour AWS session credentials in page memory
  -> direct SigV4 GET/PUT/ListObjectsV2 against the user's prefix
```

[`CognitoIdentityCredentialProvider`](../src/storage/cognito-identity-credentials.ts)
implements the two unsigned `application/x-amz-json-1.1` calls without the AWS
SDK. It coalesces refreshes, refreshes early with randomized skew, retries
documented throttling/internal failures, invalidates in-flight work on logout,
and accepts neither guest fallback nor permanent credentials. The OIDC token,
secret key, and session token are never written to browser storage.

```ts
const credentials = new CognitoIdentityCredentialProvider({
  region: "us-east-1",
  identityPoolId: "us-east-1:POOL_UUID",
  loginProvider: "issuer.example/oidc",
  getIdToken: () => authSession.freshIdToken(),
});

const identityId = await credentials.initialize();
const store = new S3ObjectStore({
  endpoint: "https://s3.us-east-1.amazonaws.com",
  region: "us-east-1",
  bucket: "airship-production",
  prefix: `airship/v1/${identityId}`,
  forcePathStyle: false,
  credentialProvider: credentials,
});
```

Use one provider instance per signed-in subject and call `reset()` before
logout/account replacement. Strict mode recomputes the stable Cognito identity
ID each page lifetime. Caching that non-secret but privacy-sensitive ID is an
optional scale optimization, not a correctness requirement.

## Identity and IAM boundary

Guest identities are disabled. The authenticated role trust policy must bind
both the pool audience and authenticated `amr`:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "cognito-identity.amazonaws.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "cognito-identity.amazonaws.com:aud": "us-east-1:POOL_UUID"
      },
      "ForAnyValue:StringLike": {
        "cognito-identity.amazonaws.com:amr": "authenticated"
      }
    }
  }]
}
```

The role may list only its own prefix and read/write only objects below it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::airship-production",
      "Condition": {
        "StringLike": {
          "s3:prefix": [
            "airship/v1/${cognito-identity.amazonaws.com:sub}/*"
          ]
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::airship-production/airship/v1/${cognito-identity.amazonaws.com:sub}/*"
    }
  ]
}
```

The policy variable is the identity-pool identity ID, not the user-pool
subject. Do not grant bucket discovery, ACL, tagging, delete, or multipart
permissions until an implemented protocol needs them. Enable S3 Block Public
Access and deny non-TLS bucket requests.

## Browser boundary

Use a DNS-compatible bucket without dots and virtual-host addressing so TLS
names the bucket directly:

```text
https://cognito-identity.us-east-1.amazonaws.com
https://airship-production.s3.us-east-1.amazonaws.com
```

The stock build's reviewed `connect-src https:` grant permits these user-owned
endpoints. The security check rejects policy drift, wildcard hosts, broad
plaintext HTTP, and WebSocket schemes. A fixed-endpoint deployment may narrow
`https:` to these exact origins, at the cost of runtime-selected providers and
storage. In either form, exact CORS and IAM scope—not CSP—are the object and
tenant authorization boundaries.

Minimum bucket CORS for the current adapter:

```json
[{ 
  "AllowedOrigins": ["https://app.airship.example"],
  "AllowedMethods": ["GET", "PUT"],
  "AllowedHeaders": [
    "Authorization", "Content-Type", "If-Match", "If-None-Match", "Range",
    "Cache-Control", "Pragma", "x-amz-content-sha256", "x-amz-date",
    "x-amz-security-token"
  ],
  "ExposeHeaders": [
    "ETag", "Content-Length", "Content-Range", "Last-Modified",
    "x-amz-request-id", "x-amz-bucket-region"
  ],
  "MaxAgeSeconds": 3600
}]
```

CORS is not authorization; IAM is the prefix boundary. A provider build is not
accepted until `runObjectStoreConformance` passes from its deployed browser
origin against a disposable prefix, including the two-writer races.

## Scale caveat

Cognito is a clean reference mechanism, not proof of billion-device capacity.
Current default Identity Pool request quotas are far below a fleet-wide hourly
refresh at that scale. Production requires activity-gated credential creation,
cached identity IDs, randomized refresh, negotiated quotas, and regional/account
partitioning. Shelby or another provider may implement the same public-client
contract with its own session capabilities instead of AWS STS.

## Primary references

- [Cognito GetId API](https://docs.aws.amazon.com/cognitoidentity/latest/APIReference/API_GetId.html)
- [Cognito GetCredentialsForIdentity API](https://docs.aws.amazon.com/cognitoidentity/latest/APIReference/API_GetCredentialsForIdentity.html)
- [AWS browser credential guidance](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/loading-browser-credentials-cognito.html)
- [Cognito identity-pool IAM roles](https://docs.aws.amazon.com/cognito/latest/developerguide/iam-roles.html)
- [Per-identity S3 IAM policy](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_examples_s3_cognito-bucket.html)
- [Cognito Identity Pool quotas](https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html#amazon-cognito-identity-pools-federated-identities-request-rate-quotas)
- [S3 CORS configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html)
