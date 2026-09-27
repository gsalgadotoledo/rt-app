import { schemaMigration } from "@gsalgadotoledo/rt-app-contracts";

/** Registers the users-bans document schema (USER_BANS#<userId> history rows). */
export const migrations = [schemaMigration("users-bans")];
