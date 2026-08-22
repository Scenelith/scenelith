# CLA signature records

Every human pull-request author must accept [`CLA.md`](../../../CLA.md) before a contribution can merge. The CLA check is mandatory for maintainers and external contributors alike.

## Sign once

1. Read `CLA.md` completely.
2. Copy `.github/cla-signature-template.json` to `.github/cla-signatures/v1/YOUR-GITHUB-LOGIN.json`.
3. Replace every placeholder. `githubLogin` must exactly match the account opening the pull request, including letter case. `legalName` and `signature` must be Your legal name and must match each other exactly.
4. Commit the signature file in Your pull request. The signature is public. Do not include an address, private email, phone number, or other personal information.

After the first accepted signature, later pull requests from the same GitHub account reuse the record already on `main`. Pull requests cannot add, replace, or delete another contributor’s signature.

If an employer or other entity owns the contribution, contact the maintainers before opening the pull request. An individual signature cannot replace authorization from the rights holder.
