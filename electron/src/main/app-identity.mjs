import path from 'node:path';

export const PRODUCT_NAME = 'ROB Studios';
export const LEGACY_PRODUCT_NAME = 'ROB Studio';
export const WINDOWS_APP_USER_MODEL_ID = 'com.robstudios.app';

export function resolveUserDataPath(appDataPath, existsSync = () => false) {
  const legacyPath = path.join(appDataPath, LEGACY_PRODUCT_NAME);
  return existsSync(legacyPath)
    ? legacyPath
    : path.join(appDataPath, PRODUCT_NAME);
}