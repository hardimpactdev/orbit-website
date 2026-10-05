// Trusted controller configuration. Never execute candidate scripts with the App token.
module.exports = {
    platform: "github",
    repositories: ["nckrtl/orbit-website"],
    autodiscover: false,
    onboarding: false,
    requireConfig: "required",
    allowScripts: false,
    allowPlugins: false,
    allowedCommands: [],
    executionTimeout: 10,
    exposeAllEnv: false,
    persistRepoData: false,
    // The same command scans without writes unless explicitly switched by the workflow.
    dryRun: process.env.MAINTENANCE_CANDIDATE_MODE === "candidate" ? null : "full",
};
