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

const octokit = new Octokit({
  auth: GITHUB_TOKEN,
  headers: {
    "X-GitHub-Api-Version": "2022-11-28",
  },
});

const userExistenceCache = new Map();
let cachedUsernameSuffixes = null;

function parseSuffixEnvValue(value) {
  return (value ?? "")
    .toString()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function getEnterpriseUsernameSuffixes() {
  if (cachedUsernameSuffixes) return cachedUsernameSuffixes;

  const suffixes = new Set();

  for (const s of parseSuffixEnvValue(process.env.ENTERPRISE_USERNAME_SUFFIX)) suffixes.add(s);

  try {
    const me = await octokit.request("GET /user");
    const login = me.data?.login;
    if (typeof login === "string" && login.includes("_")) {
      const inferred = login.split("_").pop();
      if (inferred) suffixes.add(inferred);
    }
  } catch {

  }

  const ent = (ENTERPRISE_SLUG ?? "").toString().trim();
  if (ent) {
    suffixes.add(ent);
    suffixes.add(ent.replace(/-/g, "_"));
  }

  cachedUsernameSuffixes = [...suffixes].filter(Boolean);
  return cachedUsernameSuffixes;
}

function normalizeIdentityValue(value) {
  return (value ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_.]/g, "")
    .replace(/-+/g, "-");
}

function canonicalizeUsername(value) {
  return (value ?? "").toString().trim().toLowerCase();
}

async function userExists(username) {
  if (!username) return false;
  if (userExistenceCache.has(username)) return userExistenceCache.get(username);

  try {
    await octokit.request("GET /users/{username}", { username });
    userExistenceCache.set(username, true);
    return true;
  } catch {
    userExistenceCache.set(username, false);
    return false;
  }
}

function pushUnique(list, value, seen) {
  if (!value) return;
  if (seen.has(value)) return;
  seen.add(value);
  list.push(value);
}

function generateNameBasedCandidates(displayName) {
  const parts = (displayName ?? "")
    .toString()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 2) return [];

  const first = normalizeIdentityValue(parts[0]);
  const last = normalizeIdentityValue(parts[parts.length - 1]);
  if (!first || !last) return [];

  const initial = first[0];
  return [
    `${first}-${last}`,
    `${first}.${last}`,
    `${first}_${last}`,
    `${first}${last}`,
    `${initial}${last}`,
    `${initial}.${last}`,
    `${initial}_${last}`,
    `${initial}-${last}`,
  ];
}

async function resolveGithubLoginFromScimUser(scimUser) {
  const extension = scimUser["urn:ietf:params:scim:schemas:extension:github:2.0:User"] ?? {};
  const rawCandidates = [
    extension.login,
    extension.userName,
    scimUser.userName,
    scimUser.displayName,
    scimUser.name?.formatted,
    scimUser.emails?.[0]?.value?.split("@")[0],
    ...generateNameBasedCandidates(scimUser.displayName),
  ].filter(Boolean);

  const candidates = [];
  const seen = new Set();
  const suffixes = await getEnterpriseUsernameSuffixes();

  for (const value of rawCandidates) {
    const normalized = normalizeIdentityValue(value);
    if (!normalized) continue;

    const baseVariants = new Set([
      normalized,
      normalized.replace(/-/g, "_"),
      normalized.replace(/-/g, "."),
      normalized.replace(/[-_.]/g, ""),
    ]);

    for (const suffix of suffixes) {
      for (const base of baseVariants) {
        pushUnique(candidates, `${base}_${suffix}`, seen);
      }
    }

    for (const base of baseVariants) pushUnique(candidates, base, seen);
  }

  for (const candidate of candidates) {
    if (await userExists(candidate)) return candidate;
  }

  return null;
}

async function getTeamMembersFromScimGroup(scimGroupId) {
  const response = await octokit.request(
    "GET /scim/v2/enterprises/{enterprise}/Groups/{scim_group_id}",
    {
      enterprise: ENTERPRISE_SLUG,
      scim_group_id: scimGroupId,
      headers: {
        accept: "application/scim+json",
      },
    }
  );

  const members = response.data.members ?? [];
  const usernames = new Set();
  const unresolved = [];

  for (const member of members) {
    const scimUserId = member.value;
    if (!scimUserId) continue;

    try {
      const userResponse = await octokit.request(
        "GET /scim/v2/enterprises/{enterprise}/Users/{scim_user_id}",
        {
          enterprise: ENTERPRISE_SLUG,
          scim_user_id: scimUserId,
          headers: {
            accept: "application/scim+json",
          },
        }
      );

      const resolvedLogin = await resolveGithubLoginFromScimUser(userResponse.data);
      if (resolvedLogin) {
        usernames.add(resolvedLogin);
      } else {
        const scimUserName = userResponse.data?.userName;
        const scimDisplayName = userResponse.data?.displayName;
        unresolved.push({ scimUserId, userName: scimUserName, displayName: scimDisplayName });
      }
    } catch (error) {
      console.error(`Failed to resolve SCIM user ${scimUserId} to username.`);
      if (error.status) console.error(`Status: ${error.status} | URL: ${error.request?.url}`);
      throw error;
    }
  }

  if (unresolved.length > 0) {
    const details = unresolved
      .map((u) => `  • ${u.scimUserId} (userName='${u.userName}', displayName='${u.displayName}')`)
      .join("\n");
    throw new Error(
      `Could not resolve ${unresolved.length} SCIM users to enterprise member logins. Aborting to avoid incorrect cost center updates.\n${details}`
    );
  }

  return usernames;
}

async function syncSinglePair(teamSlug, costCenterId) {
  try {
    console.log(`\n--- Starting sync for Team: ${teamSlug} -> Cost Center: ${costCenterId} ---`);

    console.log(`Fetching members for team: ${teamSlug}...`);
    let teamUsernames = new Set();
    try {
      const allTeams = await octokit.paginate(
        "GET /enterprises/{enterprise}/teams",
        { enterprise: ENTERPRISE_SLUG, per_page: 100 },
        (response) => response.data
      );
      const matchedTeam = allTeams.find(
        (t) => t.slug === teamSlug || t.slug === `ent:${teamSlug}` || t.name === teamSlug
      );
      if (!matchedTeam) {
        const available = allTeams.map((t) => `  • ${t.slug} (${t.name})`).join("\n");
        console.error(`Team slug '${teamSlug}' not found. Available enterprise teams:\n${available}`);
        throw new Error(`Team '${teamSlug}' not found in enterprise '${ENTERPRISE_SLUG}'`);
      }
      const resolvedSlug = matchedTeam.slug;
      console.log(`Matched enterprise team: "${matchedTeam.name}" (slug: ${resolvedSlug})`);

      if (matchedTeam.group_id) {
        console.log(`Team is IdP-backed (group_id: ${matchedTeam.group_id}). Fetching members via SCIM...`);
        teamUsernames = await getTeamMembersFromScimGroup(matchedTeam.group_id);
      } else {
        console.log("Team is not IdP-backed. Fetching members via enterprise team members endpoint...");
        const members = await octokit.paginate(
          "GET /enterprises/{enterprise}/teams/{team_slug}/members",
          { enterprise: ENTERPRISE_SLUG, team_slug: resolvedSlug, per_page: 100 },
          (response) => response.data
        );
        for (const m of members) teamUsernames.add(m.login);
      }
    } catch (error) {
      console.error(`Failed to fetch team members for ${teamSlug}.`);
      if (error.status) console.error(`Status: ${error.status} | URL: ${error.request?.url}`);
      throw error;
    }
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
       console.error(`Status: ${error.status} | URL: ${error.request?.url}`);
       console.error(`Response: ${JSON.stringify(error.response?.data)}`);
       throw error;
    }

    const currentCostCenterUsers = new Set(
      costCenter.resources
        .filter((r) => r.type === "User")
        .map((r) => r.name)
    );

    const desiredByCanonical = new Map();
    for (const username of teamUsernames) {
      const canon = canonicalizeUsername(username);
      if (!canon) continue;
      if (!desiredByCanonical.has(canon)) desiredByCanonical.set(canon, username);
    }

    const currentByCanonical = new Map();
    for (const username of currentCostCenterUsers) {
      const canon = canonicalizeUsername(username);
      if (!canon) continue;
      if (!currentByCanonical.has(canon)) currentByCanonical.set(canon, username);
    }

    console.log(`Found ${currentByCanonical.size} users currently assigned to cost center.`);

    const usersToAdd = [];
    for (const [canon, username] of desiredByCanonical) {
      if (!currentByCanonical.has(canon)) usersToAdd.push(username);
    }

    const usersToRemove = [];
    for (const [canon, username] of currentByCanonical) {
      if (!desiredByCanonical.has(canon)) usersToRemove.push(username);
    }

    if (usersToAdd.length > 0) {
      console.log(`Adding ${usersToAdd.length} users to cost center...`);
      try {
        await octokit.request(
          "POST /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource",
          {
            enterprise: ENTERPRISE_SLUG,
            cost_center_id: costCenterId,
            users: usersToAdd,
          }
        );
        console.log(`Successfully added: ${usersToAdd.join(", ")}`);
      } catch (error) {
        console.error("Failed to add users to cost center.");
        if (error.status) console.error(`Status: ${error.status} | URL: ${error.request?.url}`);
        console.error(`Response: ${JSON.stringify(error.response?.data)}`);
        throw error;
      }
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
    return true;
  } catch (error) {
    console.error(`Error syncing pair ${teamSlug} -> ${costCenterId}:`, error);
    return false;
  }
}

async function run() {
  try {
    const configData = await fs.readFile('config/mappings.json', 'utf8');
    const mappings = JSON.parse(configData);
    
    console.log(`Found ${mappings.length} mappings in config/mappings.json`);

    let failures = 0;
    
    for (const mapping of mappings) {
      const ok = await syncSinglePair(mapping.teamSlug, mapping.costCenterId);
      if (!ok) failures += 1;
    }

    if (failures > 0) {
      console.error(`Sync finished with ${failures} failing mapping(s).`);
      process.exitCode = 1;
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
        if (TEAM_SLUG_ENV && COST_CENTER_ID_ENV) {
            console.log("No config file found. Using environment variables.");
            const ok = await syncSinglePair(TEAM_SLUG_ENV, COST_CENTER_ID_ENV);
            if (!ok) process.exitCode = 1;
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
// It reads mappings of team slugs to cost center IDs from a config file (or environment variables),
// fetches team members (resolving SCIM users if needed), and updates the cost center resources accordingly.
// It includes robust username normalization and resolution logic to handle various naming conventions.
