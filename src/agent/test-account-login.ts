export interface TestAccountLoginDriver<Credential> {
  openHome(): Promise<unknown>;
  clickLogin(): Promise<unknown>;
  waitForUsername(): Promise<unknown>;
  fillUsername(username: Credential): Promise<unknown>;
  fillPassword(password: Credential): Promise<unknown>;
  submit(): Promise<unknown>;
  waitForSignedInUrl(): Promise<unknown>;
  verifySignedIn(): Promise<unknown>;
}

/** Shared login sequence for the dedicated E2E test account. */
export async function loginTestAccount<Credential>(
  driver: TestAccountLoginDriver<Credential>,
  credentials: { username: Credential; password: Credential },
): Promise<void> {
  await driver.openHome();
  await driver.clickLogin();
  await driver.waitForUsername();
  await driver.fillUsername(credentials.username);
  await driver.fillPassword(credentials.password);
  await driver.submit();
  await driver.waitForSignedInUrl();
  await driver.verifySignedIn();
}
