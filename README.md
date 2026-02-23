# GitHub Team to Cost Center Sync

This project automates the assignment of users to a GitHub Billing Cost Center based on their membership in a GitHub Enterprise Team.

GitHub's native Cost Center functionality currently allows assigning individual users, but does not support direct assignment of Teams or IdP Groups. This solution bridges that gap by periodically synchronizing a Team's member list with a Cost Center.

## Features

- **Automatic Synchronization**: Adds new team members to the Cost Center.
- **Cleanup**: Removes users from the Cost Center if they are no longer in the details Team (optional, see logic in script).
- **Scheduled Execution**: Runs automatically via GitHub Actions (default: every 6 hours).
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

### 3. Configure GitHub Action

1.  Navigate to your repository on GitHub.
2.  Go to **Settings** > **Secrets and variables** > **Actions**.
3.  **Secrets**:
    *   Create a New Repository Secret named `GH_PAT` and paste your Classic PAT.
4.  **Variables**:
    *   Create a New Repository Variable for `ENTERPRISE_SLUG`.

*(Note: `TEAM_SLUG` and `COST_CENTER_ID` are no longer needed as environment variables if using `config/mappings.json`, but the script will fallback to them if the config file is missing.)*

## Local Development & Testing

To run the script locally on your machine:

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Set Environment Variables**:
    ```bash
    export GH_PAT="ghp_your_token_here"
    export ENTERPRISE_SLUG="your-enterprise-slug"
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
-   **Team Not Found**: Verify the `TEAM_SLUG`. It is not the display name. Check the URL: `github.com/enterprises/<ent>/teams/<slug>`.
-   **Cost Center Not Found**: Ensure the UUID is correct.
