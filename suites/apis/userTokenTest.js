'use strict';

Feature('UserTokenAPI');

let key_id = null;
let api_key = null;

Scenario('test create APIKey success @current', async(fence, commons) => {
  let scope = ['data', 'user'];
  let api_key_res = await fence.do.createAPIKey(scope, commons.expiredAccessTokenHeader);
  fence.ask.hasAPIKey(api_key_res);
  key_id = api_key_res.body.key_id;
  api_key = api_key_res.body.api_key;
});

Scenario('create APIKey with expired access token @current', async(fence, commons) => {
  let scope = ['data', 'user'];
  let api_key_res = await fence.do.createAPIKey(scope, commons.expiredAccessTokenHeader);
  fence.ask.hasError(api_key_res, 401, 'Authentication Error: Signature has expired');
});

Scenario('refresh access token with api_key @current', async(fence) => {
  let access_token_res = await fence.do.getAccessToken(api_key);
  fence.ask.hasAccessToken(access_token_res);
});

Scenario('refresh access token with invalid api_key @current', async(fence) => {
  let access_token_res = await fence.do.getAccessToken('invalid');
  fence.ask.hasError(access_token_res, 401, 'Not enough segments')
});

Scenario('test refresh access token without api_key @current', async(fence) => {
  let access_token_res = await fence.do.getAccessToken(null);
  fence.ask.hasError(access_token_res, 400, 'Please provide an api_key in payload');
});

AfterSuite((fence) => {
  if (key_id !== null) {
    fence.do.deleteAPIKey(key_id);
    // I.deleteAPIKey('/user/credentials/cdis/', key_id);
  }
});
