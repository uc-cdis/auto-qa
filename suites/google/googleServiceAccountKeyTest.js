const chai = require('chai');
const expect = chai.expect;

const apiUtil = require('../../utils/apiUtil.js');
const { Bash } = require('../../utils/bash.js');
const bash = new Bash();


Feature('GoogleServiceAccountKey');


BeforeSuite(async (google, fence, users) => {
  await fence.complete.suiteCleanup(google, users);
});


After(async (google, fence, users) => {
  await fence.complete.suiteCleanup(google, users);
});


Scenario('Get current SA creds @reqGoogle', async (fence, users) => {
  const EXPIRES_IN = 5;

  // Make sure there are no creds for this user
  let getCredsRes = await fence.do.getUserGoogleCreds(users.user0.accessTokenHeader);
  let credsList1 = getCredsRes.access_keys;
  expect(credsList1.length,
    'There should not be existing SA keys at the beginning of the test'
  ).to.equal(0);

  // Get temporary google creds
  let tempCredsRes = await fence.complete.createTempGoogleCreds(users.user0.accessTokenHeader);
  const keyId1 = tempCredsRes.data.private_key_id;
  console.log(`Generated key ${keyId1}`);

  // Get temporary google creds with custom expiration
  tempCredsRes = await fence.complete.createTempGoogleCreds(users.user0.accessTokenHeader, EXPIRES_IN);
  const keyId2 = tempCredsRes.data.private_key_id;
  console.log(`Generated key ${keyId2}`);

  // Get list of current creds
  getCredsRes = await fence.do.getUserGoogleCreds(users.user0.accessTokenHeader);
  let credsList2 = getCredsRes.access_keys;
  console.log('Current SA creds:');
  console.log(credsList2);

  // Delete a key
  await fence.do.deleteTempGoogleCreds(
    keyId1, users.user0.accessTokenHeader);

  // Get list of current creds
  getCredsRes = await fence.do.getUserGoogleCreds(users.user0.accessTokenHeader);
  let credsList3 = getCredsRes.access_keys;

  // Clean up
  console.log('cleaning up');

  await fence.do.deleteTempGoogleCreds(
    keyId2, users.user0.accessTokenHeader);

  // Asserts
  expect(credsList2.length,
    'The 2 generated SA keys should be listed'
  ).to.equal(2);

  let key1 = credsList2.filter(key => key.name.includes(keyId1));
  expect(key1.length,
    'The generated SA key should be listed'
  ).to.equal(1);

  let start = Date.parse(key1[0].validAfterTime);
  let end = Date.parse(key1[0].validBeforeTime);
  expect(
    (end - start) / 10000,
    `The key should be set to expire in ${fence.props.linkExtendDefaultAmount} secs`
  ).to.be.within(
    fence.props.linkExtendDefaultAmount - 5,
    fence.props.linkExtendDefaultAmount + 5
  );

  let key2 = credsList2.filter(key => key.name.includes(keyId2));
  expect(key2.length,
    'The generated SA key should be listed'
  ).to.equal(1);

  start = Date.parse(key2[0].validAfterTime);
  end = Date.parse(key2[0].validBeforeTime);
  expect(
    (end - start) / 10000,
    `The key should be set to expire in ${EXPIRES_IN} secs`
  ).to.be.within(EXPIRES_IN - 5, EXPIRES_IN + 5);

  expect(credsList3.length,
    'Only 1 SA key should be listed after the other one is deleted'
  ).to.equal(1);

  key2 = credsList3.filter(key => key.name.includes(keyId2));
  expect(key2.length,
    'Only the SA key that was not deleted should be listed'
  ).to.equal(1);
}).retry(2);


Scenario('Test no data access anymore after SA key is deleted @reqGoogle', async (fence, users, google, files) => {
  // Get temporary Service Account creds, get object in bucket, delete creds
  // Get creds to access data
  const tempCreds0Res = await fence.complete.createTempGoogleCreds(users.user0.accessTokenHeader);
  const creds0Key = tempCreds0Res.data.private_key_id;
  const pathToCreds0KeyFile = creds0Key + '.json';
  await files.createTmpFile(pathToCreds0KeyFile, JSON.stringify(tempCreds0Res.data));
  console.log(`Google creds file ${pathToCreds0KeyFile} saved with contents ${tempCreds0Res.data}!`);

  // Access data
  let user0AccessQARes = await google.getFileFromBucket(
    fence.props.googleBucketInfo.QA.googleProjectId,
    pathToCreds0KeyFile,
    fence.props.googleBucketInfo.QA.bucketId,
    fence.props.googleBucketInfo.QA.fileName
  );

  // Delete the key
  await fence.do.deleteTempGoogleCreds(
    creds0Key, users.user0.accessTokenHeader);

  // Try to access data
  let user0AccessQAResExpired = await google.getFileFromBucket(
    fence.props.googleBucketInfo.QA.googleProjectId,
    pathToCreds0KeyFile,
    fence.props.googleBucketInfo.QA.bucketId,
    fence.props.googleBucketInfo.QA.fileName
  );

  // Clean up
  console.log('cleaning up');

  await fence.do.deleteTempGoogleCreds(
    creds0Key, users.user0.accessTokenHeader);
  files.deleteFile(pathToCreds0KeyFile);

  // Asserts
  chai.expect(user0AccessQARes,
    'User should have bucket access'
  ).to.have.property('id');
  chai.expect(user0AccessQAResExpired,
    'User should NOT have bucket access after key deletion'
  ).to.have.property('status').that.is.oneOf([400, 403, '400', '403']);
}).retry(2);


Scenario('Delete SA creds that do not exist @reqGoogle', async (fence, users) => {
  fakeKeyId = '64a48da067f4a4f053e6197bf2b134df7d0abcde';
  let deleteRes = await fence.do.deleteTempGoogleCreds(
    fakeKeyId, users.user0.accessTokenHeader);
  expect(deleteRes,
    'Deleting a SA key that does not exist should return 404'
  ).has.property('status', 404);
}).retry(2);


Scenario('SA key removal job test: remove expired creds @reqGoogle', async (fence, users, google, files) => {
  // Test that we do not have access to data anymore after the SA key is expired
  const EXPIRES_IN = 1;

  // Get creds to access data
  const tempCreds0Res = await fence.complete.createTempGoogleCreds(users.user0.accessTokenHeader, EXPIRES_IN);
  const creds0Key = tempCreds0Res.data.private_key_id;
  const pathToCreds0KeyFile = creds0Key + '.json';
  await files.createTmpFile(pathToCreds0KeyFile, JSON.stringify(tempCreds0Res.data));
  console.log(`Google creds file ${pathToCreds0KeyFile} saved!`);

  // Access data
  let user0AccessQARes = await google.getFileFromBucket(
    fence.props.googleBucketInfo.QA.googleProjectId,
    pathToCreds0KeyFile,
    fence.props.googleBucketInfo.QA.bucketId,
    fence.props.googleBucketInfo.QA.fileName
  );

  // Wait for the key to expire
  console.log('waiting for the key to expire');
  await apiUtil.sleepMS((EXPIRES_IN + 5) * 1000);

  // Run the expired SA key clean up job
  console.log('Clean up expired Service Account keys');
  bash.runJob('google-manage-keys-job');

  // Try to access data
  let user0AccessQAResExpired = await google.getFileFromBucket(
    fence.props.googleBucketInfo.QA.googleProjectId,
    pathToCreds0KeyFile,
    fence.props.googleBucketInfo.QA.bucketId,
    fence.props.googleBucketInfo.QA.fileName
  );

  // Clean up
  console.log('cleaning up');

  // should have been deleted by the google-manage-keys-job
  // send delete request just in case (do not check if it was actually deleted)
  await fence.do.deleteTempGoogleCreds(
    creds0Key, users.user0.accessTokenHeader);

  files.deleteFile(pathToCreds0KeyFile);

  // Asserts
  chai.expect(user0AccessQARes,
    'User should have bucket access before expiration'
  ).to.have.property('id');
  chai.expect(user0AccessQAResExpired,
    'User should NOT have bucket access after expiration'
  ).to.have.property('status').that.is.oneOf([400, 403, '400', '403']);
}).retry(2);


Scenario('SA key removal job test: remove expired creds that do not exist in google @reqGoogle', async (fence, users, google) => {
  // Test that the job removes keys from the fence DB even if some of them do not exist in google

  const EXPIRES_IN = 1;

  // Get creds to access data
  let tempCredsRes = await fence.complete.createTempGoogleCreds(users.user0.accessTokenHeader, EXPIRES_IN);
  let credsKey1 = tempCredsRes.data.private_key_id;

  // Get other creds to access data, with short expiration time
  tempCredsRes = await fence.complete.createTempGoogleCreds(users.user0.accessTokenHeader, EXPIRES_IN);
  let credsKey2 = tempCredsRes.data.private_key_id;

  // Get the complete name of the generated key and delete it in google
  let getCredsRes = await fence.do.getUserGoogleCreds(users.user0.accessTokenHeader);
  let credsList = getCredsRes.access_keys;
  let key = credsList.filter(key => key.name.includes(credsKey1))[0];
  await google.deleteServiceAccountKey(key.name);

  // Wait for the keys to expire
  console.log('waiting for the key to expire');
  await apiUtil.sleepMS((EXPIRES_IN + 5) * 1000);

  // Run the expired SA key clean up job
  console.log('Clean up expired Service Account keys');
  bash.runJob('google-manage-keys-job');

  // Get list of current creds
  getCredsRes = await fence.do.getUserGoogleCreds(users.user0.accessTokenHeader);
  credsList = getCredsRes.access_keys;

  // Clean up
  console.log('cleaning up');

  // should have been deleted by the google-manage-keys-job
  // send delete request just in case (do not check if it was actually deleted)
  await fence.do.deleteTempGoogleCreds(
    credsKey1, users.user0.accessTokenHeader);
  await fence.do.deleteTempGoogleCreds(
    credsKey2, users.user0.accessTokenHeader);

  // Asserts
  chai.expect(credsList.length,
      'The expired SA keys should have been removed'
    ).to.equal(0);
}).retry(2);