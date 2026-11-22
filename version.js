// Game page version (Claude 2026-11-18), the single source for the footer and
// the room compatibility check (as Daytona USA Web's room-settings.js). Rooms
// only connect cabinets with the same BUILD_ID: a guest from another version is
// refused, and public rooms of another version show as "Different version".
// Raise CLIENT_VERSION and RELEASE_DATE with every publication.
export const CLIENT_VERSION = '0.10.3';
export const RELEASE_DATE = '2026-11-21';
export const BUILD_ID = `daytona2pe-web-${CLIENT_VERSION}`;
export const versionMismatch = () => `Version mismatch. This room requires v${CLIENT_VERSION}. All players must reload the latest game page before joining.`;
