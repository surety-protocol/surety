#!/usr/bin/env bash
# Run ONCE, right after the repo is made public (GitHub Free only allows branch
# protection on public repos). Needs an org admin logged in to the GitHub CLI.
#
#   bash .github/protect-main.sh
#
# Result: main only changes through a pull request, CI must pass on all three
# test jobs, one approval is needed, force-pushes and deletion are blocked.
# Admins can still bypass in an emergency (enforce_admins: false).
set -euo pipefail
REPO="surety-protocol/surety"

gh api -X PUT "repos/$REPO/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Tests (ubuntu-latest, Node 24)",
      "Tests (ubuntu-latest, Node 22)",
      "Tests (windows-latest, Node 24)"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
echo "main is protected on $REPO"
