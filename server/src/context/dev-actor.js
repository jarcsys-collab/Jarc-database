// DEVELOPMENT / PRE-AUTH ONLY. This is not authentication.
//
// Microsoft Entra sign-in does not exist yet, but documents need an owner (createdBy, updatedBy, memberships).
// Until real authentication arrives, every resource request in development and test is attributed to one fixed
// user, "Local developer (pre-auth)". There is no login, password, token or header that selects it, so it can't be
// mistaken for, or extended into, a sign-in system.
//
// Production is refused twice: the resource API is never mounted when NODE_ENV=production (see config), and both
// functions below throw if they are ever called with the production environment.
const DEV_ACTOR = Object.freeze({ devKey: "local-developer", displayName: "Local developer (pre-auth)" });

function assertNotProduction(environment) {
  if (environment === "production") throw new Error("The development actor is never available in production. Real authentication is required.");
}

async function ensureDevelopmentActor(users, { environment, now = new Date() }) {
  assertNotProduction(environment);
  return users.ensureDevelopmentUser({ ...DEV_ACTOR, now });
}

// Attaches req.actor for the resource routes and labels every response as pre-auth.
function devActorMiddleware(actorUser, { environment }) {
  assertNotProduction(environment);
  // The single local developer: treated as SYSTEM_ADMIN so every resource is reachable (development only).
  const actor = Object.freeze({ userId: actorUser._id, kind: "development", isSystemAdmin: true });
  return (req, res, next) => {
    req.actor = actor;
    res.set("X-JARC-Auth", "development-pre-auth");
    next();
  };
}

module.exports = { DEV_ACTOR, ensureDevelopmentActor, devActorMiddleware };
