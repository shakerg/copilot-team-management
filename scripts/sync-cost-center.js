import { Octokit } from "octokit";
import fs from 'fs/promises';

const GITHUB_TOKEN = process.env.GH_PAT;
const ENTERPRISE_SLUG = process.env.ENTERPRISE_SLUG;
const TEAM_SLUG_ENV = process.env.TEAM_SLUG;
const COST_CENTER_ID_ENV = process.env.COST_CENTER_ID;

if (!GITHUB_TOKEN || !ENTERPRISE_SLUG) {
  console.error("Error: Missing required environment variables.");
  console.error("Required: GH_PAT, ENTERPRISE_SLUG");
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

async function syncSinglePair(teamSlug, costCenterId) {
  try {
    console.log(`\n--- Starting sync for Team: ${teamSlug} -> Cost Center: ${costCenterId} ---`);

    console.log(`Fetching members for team: ${teamSlug}...`);
    let teamMembers = [];
    try {
      teamMembers = await octokit.paginate(
        "GET /enterprises/{enterprise}/teams/{team_slug}/members",
        {
          enterprise: ENTERPRISE_SLUG,
          team_slug: teamSlug,
        }
      );
    } catch (error) {
       console.error(`Failed to fetch team members for ${teamSlug}. Ensure the team slug is correct and the PAT has permissions.`);
       throw error;
    }
    
    const teamUsernames = new Set(teamMembers.map((u) => u.login));
    console.log(`Found ${teamUsernames.size} members in team '${teamSlug}'.`);

    console.log(`Fetching resources for cost center: ${costCenterId}...`);
    let costCenter;
    try {
      const response = await octokit.request(
        "GET /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}",
        {
          enterprise: ENTERPRISE_SLUG,
          cost_center_id: costCenterId,
        }
      );
      costCenter = response.data;
    } catch (error) {
       console.error(`Failed to fetch cost center ${costCenterId}. Ensure ID is correct.`);
       throw error;
    }

    const currentCostCenterUsers = new Set(
      costCenter.resources
        .filter((r) => r.type === "User")
        .map((r) => r.name)
    );
    console.log(`Found ${currentCostCenterUsers.size} users currently assigned to cost center.`);

    const usersToAdd = [...teamUsernames].filter((u) => !currentCostCenterUsers.has(u));
    const usersToRemove = [...currentCostCenterUsers].filter((u) => !teamUsernames.has(u));

    if (usersToAdd.length > 0) {
      console.log(`Adding ${usersToAdd.length} users to cost center...`);
      await octokit.request(
        "POST /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource",
        {
          enterprise: ENTERPRISE_SLUG,
          cost_center_id: costCenterId,
          users: usersToAdd,
        }
      );
      console.log(`Successfully added: ${usersToAdd.join(", ")}`);
    } else {
      console.log("No new users to add.");
    }

    if (usersToRemove.length > 0) {
      console.log(`Removing ${usersToRemove.length} users from cost center...`);
      await octokit.request(
        "DELETE /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource",
        {
          enterprise: ENTERPRISE_SLUG,
          cost_center_id: costCenterId,
          users: usersToRemove,
        }
      );
      console.log(`Successfully removed: ${usersToRemove.join(", ")}`);
    } else {
      console.log("No users to remove.");
    }
    
    console.log(`--- Sync complete for ${teamSlug} ---`);
  } catch (error) {
    console.error(`Error syncing pair ${teamSlug} -> ${costCenterId}:`, error);
  }
}

async function run() {
  try {
    const configData = await fs.readFile('config/mappings.json', 'utf8');
    const mappings = JSON.parse(configData);
    
    console.log(`Found ${mappings.length} mappings in config/mappings.json`);
    
    for (const mapping of mappings) {
      await syncSinglePair(mapping.teamSlug, mapping.costCenterId);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
        if (TEAM_SLUG_ENV && COST_CENTER_ID_ENV) {
            console.log("No config file found. Using environment variables.");
            await syncSinglePair(TEAM_SLUG_ENV, COST_CENTER_ID_ENV);
        } else {
            console.error("Error: No config file (config/mappings.json) and missing env vars (TEAM_SLUG, COST_CENTER_ID).");
            process.exit(1);
        }
    } else {
        console.error("Error reading config file:", error);
        process.exit(1);
    }
  }
}

run();

// summarize this code for review purposes:
// This script synchronizes GitHub Enterprise team memberships with cost center assignments. 
// It reads mappings of team slugs to cost center IDs from a config file (config/mappings.json) 
// or environment variables. For each mapping, it fetches the current team members and cost center 
// resources, then adds users to the cost center if they're in the team but not assigned, and 
// removes users from the cost center if they're assigned but not in the team. The script uses 
// the Octokit library to interact with the GitHub API and is designed to be run as a scheduled GitHub Action.