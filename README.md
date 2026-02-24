# GitHub Team to Cost Center Sync

This project automates the assignment of users to a GitHub Billing Cost Center based on their membership in a GitHub Enterprise Team.

GitHub's native Cost Center functionality currently allows assigning individual users, but does not support direct assignment of Teams or IdP Groups. This solution bridges that gap by periodically synchronizing a Team's member list with a Cost Center.

## Features

- **Automatic Synchronization**: Adds new team members to the Cost Center.
- **Cleanup**: Removes users from the Cost Center if they are no longer in the team (optional, see logic in script).
- **Scheduled Execution**: Runs automatically via GitHub Actions (default: every hour).
- **Manual Trigger**: Can be run manually from the Actions tab.

## Prerequisites

- **GitHub Enterprise Cloud**: This script works with GitHub Enterprise Cloud APIs.
- **Admin Access**: You need an Enterprise Admin account to generate the required Personal Access Token (PAT).
- **Node.js**: v20 or higher (for local development).

## Setup

### 1. Create a Personal Access Token (PAT)

The Cost Center API currently requires a **Classic Personal Access Token**. Fine-grained tokens and GitHub App tokens are **not** supported for these specific billing endpoints.

1.  Go to **Settings** > **Developer settings** > **Personal access tokens** > **Tokens (classic)**.
2.  Generate a new token.
3.  Select the `admin:enterprise` scope.
4.  Copy the token value (you will need this for the `GH_PAT` secret).

### 2. Configure Mappings

This tool supports syncing multiple Teams to multiple Cost Centers.

1.  Open `config/mappings.json`.
2.  Add your mappings in the following format:
    ```json
    [
      {
        "teamSlug": "fallout",
        "costCenterId": "uuid-for-fallout"
      },
      {
        "teamSlug": "empire",
        "costCenterId": "uuid-for-empire"
      }
    ]
    ```

If `config/mappings.json` is missing, the script can also run in **single mapping** mode using environment variables:

- `TEAM_SLUG`
- `COST_CENTER_ID`

### Finding Cost Center IDs

Cost Centers require a UUID, not a display name. To look up the IDs for all cost centers in your enterprise, run:

```bash
gh api /enterprises/YOUR_ENTERPRISE_SLUG/settings/billing/cost-centers
```

Example output:

```json
{
  "cost_centers": [
    {
      "id": "cc_abc1234567890",
      "name": "name",
      ...
    }
  ]
}
```

Use the `id` value (e.g. `cc_abc1234567890`) as the `costCenterId` in `config/mappings.json`.

> **Note**: You must be authenticated as an Enterprise Admin. Run `gh auth login` first if needed.

### 3. Configure GitHub Action

1.  Navigate to your repository on GitHub.
2.  Go to **Settings** > **Secrets and variables** > **Actions**.
3.  **Secrets**:
    *   Create a New Repository Secret named `GH_PAT` and paste your Classic PAT.
4.  **Variables**:
    *   Create a New Repository Variable for `ENTERPRISE_SLUG`.

Optional (recommended for EMU):

- Create a Repository Variable `ENTERPRISE_USERNAME_SUFFIX` (example: `pipboy`).

*(Note: `TEAM_SLUG` and `COST_CENTER_ID` are only needed if you are not using `config/mappings.json`.)*

## Running in GitHub Actions

This repo includes a workflow at `.github/workflows/sync-cost-center.yml`.

### Scheduled runs

By default the workflow runs every hour.

### Manual runs (recommended for testing)

If you’re changing which team maps to a cost center, update `config/mappings.json` on the default branch and push first.

1. Go to the repository on GitHub.
2. Open **Actions**.
3. Select **Sync Cost Center with Team**.
4. Click **Run workflow**.

The job will fail (red) if any mapping fails to sync.

### Variables and secrets used by the workflow

- **Secret**: `GH_PAT` (Classic PAT, `admin:enterprise`)
- **Variable**: `ENTERPRISE_SLUG`
- **Variable (optional)**: `ENTERPRISE_USERNAME_SUFFIX` (EMU username suffix, e.g. `pipboy`)
- **Variables (optional fallback)**: `TEAM_SLUG`, `COST_CENTER_ID` (only used if `config/mappings.json` is missing)

## Running locally (manual)

To run the script locally on your machine:

1.  **Install Dependencies**:
    ```bash
    npm ci
    ```

2.  **Set Environment Variables**:
    ```bash
    export GH_PAT="ghp_your_token_here"
    export ENTERPRISE_SLUG="your-enterprise-slug"
    # Recommended for EMU: set the enterprise username suffix used in EMU logins.
    # Example: if your enterprise usernames look like "jane-doe_pipboy", set this to "pipboy".
    export ENTERPRISE_USERNAME_SUFFIX="pipboy"
    ```
3.  **Ensure `config/mappings.json` is configured correctly.**

4.  **Run the Script**:
    ```bash
    npm run sync
    ```

## Logic & Warnings

Current behavior of `scripts/sync-cost-center.js`:

1.  **Fetches Team Members**: Gets all members of the specified Enterprise Team.
2.  **Fetches Cost Center Resources**: Gets all users currently assigned to the Cost Center.
3.  **Calculates Diff**:
    *   **Adds**: Users in the Team but not in the Cost Center.
    *   **Removes**: Users in the Cost Center but not in the Team.

**⚠️ IMPORTANT**: The removal logic assumes that **ONLY** members of this specific team should be in this Cost Center. If you have other users manually assigned to this Cost Center who are *not* in the team, **THEY WILL BE REMOVED** by this script.

To disable removal, edit `scripts/sync-cost-center.js` and comment out the removal block.

## Troubleshooting

-   **403 Forbidden**: Ensure your PAT is a **Classic** token and has the `admin:enterprise` scope. GitHub App tokens will not work.
-   **403 "These users are not part of enterprise"**: For EMU, make sure the script is resolving to the EMU-style usernames (often suffixed like `*_pipboy`). Set `ENTERPRISE_USERNAME_SUFFIX` explicitly if auto-detection doesn't work.
-   **Could not resolve SCIM users**: The team is IdP-backed and the SCIM user records did not contain a direct GitHub login. Set `ENTERPRISE_USERNAME_SUFFIX` and ensure the generated usernames match your EMU login format.
-   **Team Not Found**: Verify the `TEAM_SLUG`. It is not the display name. Check the URL: `github.com/enterprises/<ent>/teams/<slug>`.
-   **Cost Center Not Found**: Ensure the UUID is correct. See [Finding Cost Center IDs](#finding-cost-center-ids) below.
