const { expect } = require('chai');
const fs = require('fs');
const homedir = require('os').homedir();

const { inJenkins } = require('../../utils/commons.js');

Feature('Data file upload flow').retry(2);

// ///////////
// GLOBALS //
// ///////////

// maintain a list of GUIDs to delete in indexd and the S3 bucket at the end
const createdGuids = [];

const fileContents = 'this fake data file was generated and uploaded by the integration test suite\n';

// the following variables are set as part of the BeforeSuite step:
let fileName; let filePath; let fileSize; let
  fileMd5;
let bigFileName; let bigFileSize; let bigFileMd5; let bigFileContents; let
  bigFileParts;

// //////////////////
// UTIL FUNCTIONS //
// //////////////////

/**
 * request a  presigned URL from fence
 */
const getUploadUrlFromFence = async function (fence, users) {
  const accessHeader = users.mainAcct.accessTokenHeader;
  const res = await fence.do.getUrlForDataUpload(fileName, accessHeader);
  fence.ask.hasUrl(res);
  return res;
};

/**
 * Complete data upload flow using API calls
 * - Use fence to upload a file to S3
 * - Check that we cannot link metadata to a file without hash and size
 * - check that the indexd listener updates the record with the correct hash and size
 * - Link metadata to the file via sheepdog
 * - Download the file via fence and check who can download and when
 */
Scenario('File upload and download via API calls @dataUpload', async ({
  fence, users, nodes, indexd, sheepdog, dataUpload,
}) => {
  console.log(`${new Date()}: request a  presigned URL from fence`);
  const fenceUploadRes = await getUploadUrlFromFence(fence, users);
  const fileGuid = fenceUploadRes.data.guid;
  createdGuids.push(fileGuid);
  const presignedUrl = fenceUploadRes.data.url;

  console.log(`${new Date()}: check that a (blank) record was created in indexd`);
  const fileNode = {
    did: fileGuid,
    data: {
      md5sum: fileMd5,
      file_size: fileSize,
    },
  };
  await indexd.complete.checkRecordExists(fileNode);

  console.log(`${new Date()}: try to link metadata to the file before the indexd listener updates the record with size and hash: this should fail.`);
  // we simulate not waiting by not uploading the file to the S3 bucket yet

  console.log(`${new Date()}: fail to submit metadata for this file`);
  let sheepdogRes = await nodes.submitGraphAndFileMetadata(sheepdog, fileGuid, fileSize, fileMd5);
  sheepdog.ask.hasStatusCode(sheepdogRes.addRes, 400, 'Linking metadata to file without hash and size should not be possible');

  console.log(`${new Date()}: check that we CANNOT download the file (there is no URL in indexd yet)`);
  let signedUrlRes = await fence.do.createSignedUrlForUser(fileGuid);
  fence.ask.hasNoUrl(signedUrlRes);

  console.log(`${new Date()}: now, upload the file to the S3 bucket using the presigned URL`);
  await dataUpload.uploadFileToS3(presignedUrl, filePath, fileSize);

  console.log(`${new Date()}: wait for the indexd listener to add size, hashes and URL to the record`);
  await dataUpload.waitUploadFileUpdatedFromIndexdListener(indexd, fileNode);

  console.log(`${new Date()}: Try downloading before linking metadata to the file. It should succeed for the uploader but fail for other users`);

  console.log(`${new Date()}: the uploader can now download the file`);
  signedUrlRes = await fence.do.createSignedUrlForUser(fileGuid);
  await fence.complete.checkFileEquals(
    signedUrlRes,
    fileContents,
  );

  console.log(`${new Date()}: a user who is not the uploader CANNOT download the file`);
  signedUrlRes = await fence.do.createSignedUrlForUser(
    fileGuid,
    users.auxAcct1.accessTokenHeader,
  );
  fence.ask.assertStatusCode(signedUrlRes, 401, 'User who is not the uploader should not successfully download file before metadata linking');

  console.log(`${new Date()}: submit metadata for this file`);
  sheepdogRes = await nodes.submitGraphAndFileMetadata(sheepdog, fileGuid, fileSize, fileMd5);
  sheepdog.ask.addNodeSuccess(sheepdogRes);

  console.log(`${new Date()}: a user who is not the uploader can now download the file`);
  signedUrlRes = await fence.do.createSignedUrlForUser(
    fileGuid,
    users.auxAcct1.accessTokenHeader,
  );
  await fence.complete.checkFileEquals(
    signedUrlRes,
    fileContents,
  );

  console.log(`${new Date()}: check that we cannot link metadata to a file that already has metadata.`);
  // try to submit metadata for this file again
  sheepdogRes = await nodes.submitGraphAndFileMetadata(
    sheepdog,
    fileGuid,
    fileSize,
    fileMd5,
    'submitter_id_new_value',
  );
  sheepdog.ask.addNodeSuccess(sheepdogRes);
}).retry(1);

/**
 * A user who does not have upload access should not be able to upload
 * or download files
 */
Scenario('User without role cannot upload @dataUpload', async ({ fence, users }) => {
  // this user does not have the appropriate role
  const token = users.auxAcct1.accessTokenHeader;

  // request a  presigned URL from fence
  const fenceUploadRes = await fence.do.getUrlForDataUpload(fileName, token);

  // fence should not let this user upload
  fence.ask.hasNoUrl(fenceUploadRes);
  fence.ask.assertStatusCode(fenceUploadRes, 403, 'This user should not be able to download');
}).retry(1);

/**
 * This time, use the gen3 data client to upload and download the file
 *
 * Disabled in run-tests.sh for now - dataClient manages configuration
 * in a shared home directory folder - need to add locking, or make
 * the config folder configurable ...
 *
 */
Scenario('File upload and download via client @dataClientCLI @dataUpload', async ({
  dataClient, fence, users, indexd, files, dataUpload,
}) => {
  // configure the gen3-client
  await dataClient.do.configureClient(fence, users, files);

  // use gen3 client to upload a file
  const fileGuid = await dataClient.do.uploadFile(filePath);
  createdGuids.push(fileGuid);

  // check that a (blank) record was created in indexd
  const fileNode = {
    did: fileGuid,
    data: {
      md5sum: fileMd5,
      file_size: fileSize,
    },
  };
  await indexd.complete.checkRecordExists(fileNode);

  // wait for the indexd listener to add size, hashes and URL to the record
  await dataUpload.waitUploadFileUpdatedFromIndexdListener(indexd, fileNode);

  // download the file via the data client
  const downloadPath = './tmpFileDestination.txt';
  await dataClient.complete.downloadFile(files, fileGuid, downloadPath, fileContents);
});

/**
 * Upload a file, then delete it through fence. Aftert deletion, the file
 * should not be accessible for metadata linking or download
 */
Scenario('Data file deletion @dataUpload', async ({
  fence, users, indexd, sheepdog, nodes, dataUpload,
}) => {
  // request a  presigned URL from fence
  const fenceUploadRes = await getUploadUrlFromFence(fence, users);
  const fileGuid = fenceUploadRes.data.guid;
  const presignedUrl = fenceUploadRes.data.url;

  // upload the file to the S3 bucket using the presigned URL
  await dataUpload.uploadFileToS3(presignedUrl, filePath, fileSize);

  const fileNode = {
    did: fileGuid,
    data: {
      md5sum: fileMd5,
      file_size: fileSize,
    },
  };

  // wait for the indexd listener to add size, hashes and URL to the record
  await dataUpload.waitUploadFileUpdatedFromIndexdListener(indexd, fileNode);

  // check that a user who is not the uploader cannot delete the file
  const fenceRes = await fence.do.deleteFile(
    fileGuid,
    users.auxAcct1.accessTokenHeader,
  );
  fence.ask.assertStatusCode(fenceRes, 403, 'File deletion from user who is not file uploader should not be possible');

  // delete the file
  await fence.complete.deleteFile(fileGuid);

  // no match in indexd after delete
  const indexdRes = await indexd.do.getFile(fileNode);
  indexd.ask.resultFailure(indexdRes);

  // no metadata linking after delete
  const sheepdogRes = await nodes.submitGraphAndFileMetadata(sheepdog, fileGuid, fileSize, fileMd5);
  sheepdog.ask.hasStatusCode(sheepdogRes.addRes, 400, 'Metadata linking should not be possible after file deletion');

  // no download after delete
  const signedUrlRes = await fence.do.createSignedUrlForUser(fileGuid);
  fence.ask.assertStatusCode(signedUrlRes, 404, 'File download should not be possible after file deletion');
}).retry(1);

/**
 * Upload 2 files with the same contents (so same hash and size) and
 * link metadata to them via sheepdog
 */
Scenario('Upload the same file twice @dataUpload', async ({
  sheepdog, indexd, nodes, users, fence, dataUpload,
}) => {
  // //////////
  // FILE 1 //
  // //////////

  // request a  presigned URL from fence
  let fenceUploadRes = await getUploadUrlFromFence(fence, users);
  let fileGuid = fenceUploadRes.data.guid;
  createdGuids.push(fileGuid);
  let presignedUrl = fenceUploadRes.data.url;

  // upload the file to the S3 bucket using the presigned URL
  await dataUpload.uploadFileToS3(presignedUrl, filePath, fileSize);

  const fileNode = {
    did: fileGuid,
    data: {
      md5sum: fileMd5,
      file_size: fileSize,
    },
  };

  // wait for the indexd listener to add size, hashes and URL to the record
  await dataUpload.waitUploadFileUpdatedFromIndexdListener(indexd, fileNode);

  // submit metadata for this file
  let sheepdogRes = await nodes.submitGraphAndFileMetadata(sheepdog, fileGuid, fileSize, fileMd5);
  sheepdog.ask.addNodeSuccess(sheepdogRes, 'first upload');

  // check that the file can be downloaded
  let signedUrlRes = await fence.do.createSignedUrlForUser(fileGuid);
  await fence.complete.checkFileEquals(
    signedUrlRes,
    fileContents,
  );

  // //////////
  // FILE 2 //
  // //////////

  // request a  presigned URL from fence
  fenceUploadRes = await getUploadUrlFromFence(fence, users);
  fileGuid = fenceUploadRes.data.guid;
  createdGuids.push(fileGuid);
  presignedUrl = fenceUploadRes.data.url;

  // upload the file to the S3 bucket using the presigned URL
  await dataUpload.uploadFileToS3(presignedUrl, filePath, fileSize);

  // wait for the indexd listener to add size, hashes and URL to the record
  fileNode.did = fileGuid;
  await dataUpload.waitUploadFileUpdatedFromIndexdListener(indexd, fileNode);

  // submit metadata for this file
  sheepdogRes = await nodes.submitGraphAndFileMetadata(
    sheepdog,
    fileGuid,
    fileSize,
    fileMd5,
    'submitter_id_new_value',
  );
  sheepdog.ask.addNodeSuccess(sheepdogRes, 'second upload');

  // check that the file can be downloaded
  signedUrlRes = await fence.do.createSignedUrlForUser(fileGuid);
  await fence.complete.checkFileEquals(
    signedUrlRes,
    fileContents,
  );
}).retry(1);

/**
 * Use fence's multipart upload endpoints to upload a large data file (>5MB)
 */
Scenario('Successful multipart upload @dataUpload @multipartUpload', async ({
  users, fence, indexd, dataUpload,
}) => {
  // initialize the multipart upload
  console.log('Initializing multipart upload');
  const accessHeader = users.mainAcct.accessTokenHeader;
  const initRes = await fence.complete.initMultipartUpload(bigFileName, accessHeader);
  const fileGuid = initRes.guid;
  createdGuids.push(fileGuid);
  const key = `${fileGuid}/${bigFileName}`;

  // upload each file part to the S3 bucket
  const partsSummary = [];
  for (let partNumber = 1; partNumber <= Object.keys(bigFileParts).length; partNumber += 1) {
    console.log(`Uploading file part ${partNumber}`);

    // get a presigned URL from fence
    const getUrlRes = await fence.complete.getUrlForMultipartUpload(
      key,
      initRes.uploadId,
      partNumber,
      accessHeader,
    );

    // upload the file part using the presigned URL
    const uploadPartRes = await dataUpload.uploadFilePartToS3(
      getUrlRes.url,
      bigFileParts[partNumber],
    );

    partsSummary.push({
      PartNumber: partNumber,
      ETag: uploadPartRes,
    });
  }

  // complete the multipart upload
  console.log('Completing multipart upload');
  await fence.complete.completeMultipartUpload(key, initRes.uploadId, partsSummary, accessHeader);

  // wait for the indexd listener to add size, hashes and URL to the record
  const fileNode = {
    did: fileGuid,
    data: {
      md5sum: bigFileMd5,
      file_size: bigFileSize,
    },
  };
  await dataUpload.waitUploadFileUpdatedFromIndexdListener(indexd, fileNode);

  // download the file
  console.log('Downloading the file');
  const signedUrlRes = await fence.do.createSignedUrlForUser(fileGuid);
  fence.ask.assertStatusCode(signedUrlRes, 200, 'Could not get signed URL for file download after completing multipart upload');
  fence.complete.checkFileEquals(signedUrlRes, bigFileContents.toString());
}).retry(1);

/**
 * Use fence's multipart upload endpoints to upload a large data file (>5MB).
 * Fail to complete the upload because of a wrong ETag input
 */
Scenario('Failed multipart upload: wrong ETag for completion @dataUpload @multipartUpload @multipartUploadFailure', async ({ users, fence, dataUpload }) => {
  // initialize the multipart upload
  console.log('Initializing multipart upload');
  const accessHeader = users.mainAcct.accessTokenHeader;
  const initRes = await fence.complete.initMultipartUpload(bigFileName, accessHeader);
  const fileGuid = initRes.guid;
  createdGuids.push(fileGuid);
  const key = `${fileGuid}/${bigFileName}`;

  // upload each file part to the S3 bucket
  const partsSummary = [];
  for (let partNumber = 1; partNumber <= Object.keys(bigFileParts).length; partNumber += 1) {
    console.log(`Uploading file part ${partNumber}`);

    // get a presigned URL from fence
    const getUrlRes = await fence.complete.getUrlForMultipartUpload(
      key,
      initRes.uploadId,
      partNumber,
      accessHeader,
    );

    // upload the file part using the presigned URL
    const uploadPartRes = await dataUpload.uploadFilePartToS3(
      getUrlRes.url,
      bigFileParts[partNumber],
    );

    partsSummary.push({
      PartNumber: partNumber,
      ETag: `${uploadPartRes}fake`, // wrong ETag
    });
  }

  // complete the multipart upload
  console.log('Trying to complete multipart upload');
  const completeRes = await fence.do.completeMultipartUpload(
    key,
    initRes.uploadId,
    partsSummary,
    accessHeader,
  );
  expect(completeRes, 'Should not have been able to complete multipart upload with wrong ETags').to.not.have.property('status', 200);

  // try to download the file
  console.log('Try to download the file');
  const signedUrlRes = await fence.do.createSignedUrlForUser(fileGuid);
  fence.ask.assertStatusCode(signedUrlRes, 404, 'Should not be able to get signed URL for file download when multipart upload completion failed');
}).retry(1);

/**
 * Test data upload flow with consent codes in metadata:
 * - Get presigned URL from fence, upload file to s3
 *   (indexd listener creates blank index record)
 * - Link metadata with consent codes to the file via sheepdog
 * - Check that the consent codes end up in the indexd record
 */
Scenario('File upload with consent codes @dataUpload @indexRecordConsentCodes', async ({
  fence, users, nodes, indexd, sheepdog, dataUpload,
}) => {
  // request a presigned URL from fence
  const fenceUploadRes = await getUploadUrlFromFence(fence, users);
  const fileGuid = fenceUploadRes.body.guid;
  createdGuids.push(fileGuid);
  const presignedUrl = fenceUploadRes.body.url;

  // check that a (blank) record was created in indexd
  const fileNode = {
    did: fileGuid,
    data: {
      md5sum: fileMd5,
      file_size: fileSize,
    },
  };
  await indexd.complete.checkRecordExists(fileNode);

  // now, upload the file to the S3 bucket using the presigned URL
  await dataUpload.uploadFileToS3(presignedUrl, filePath, fileSize);

  // wait for the indexd listener to add size, hashes and URL to the record
  await dataUpload.waitUploadFileUpdatedFromIndexdListener(indexd, fileNode);

  // submit metadata for this file, including consent codes
  const sheepdogRes = await nodes.submitGraphAndFileMetadata(
    sheepdog, fileGuid, fileSize, fileMd5, null, ['cc1', 'cc_2'],
  );
  sheepdog.ask.addNodeSuccess(sheepdogRes);

  // check that record was updated in indexd and has correct consent codes
  const fileNodeWithCCs = {
    did: fileGuid,
    authz: [
      '/consents/cc1',
      '/consents/cc_2',
    ],
    data: {
      md5sum: fileMd5,
      file_size: fileSize,
    },
  };
  await indexd.complete.checkFile(fileNodeWithCCs);
}).retry(1);

/**
 * Checks if the gen3-client executable is present in the workspace.
 * During a local run, checks in the homedir instead.
 * It is needed for the data upload test suite
 */
function assertGen3Client() {
  // check if the client is set up in the workspace
  console.log('Looking for data client executable...');
  const clientDir = process.env.DATA_CLIENT_PATH || homedir;
  if (!fs.existsSync(`${clientDir}/gen3-client`)) {
    const msg = `Did not find a gen3-client executable in ${clientDir}`;
    if (inJenkins) {
      throw Error(msg);
    }
    console.log(`WARNING: ${msg}`);
  }
}

BeforeSuite(async ({ sheepdog, files }) => {
  assertGen3Client();
  // clean up in sheepdog
  await sheepdog.complete.findDeleteAllNodes();

  // generate file names unique to this session
  const rand = (Math.random() + 1).toString(36).substring(2, 7); // 5 random chars
  fileName = `qa-upload-file_${rand}.txt`;
  filePath = `./${fileName}`;
  bigFileName = `qa-upload-7mb-file_${rand}.txt`;

  // create a local small file to upload. store its size and hash
  await files.createTmpFile(filePath, fileContents);
  fileSize = files.getFileSize(filePath);
  fileMd5 = await files.getFileHash(filePath);

  // create a local large file (size 7MB)
  await files.createBigTmpFile(bigFileName, 7);
  bigFileSize = files.getFileSize(bigFileName);
  bigFileMd5 = await files.getFileHash(bigFileName);

  // each part of the large file must be >=5MB (except the last part)
  bigFileContents = fs.readFileSync(bigFileName);
  const fiveMbLength = Math.floor((bigFileContents.length * 5) / 7);
  bigFileParts = {
    1: bigFileContents.slice(0, fiveMbLength),
    2: bigFileContents.slice(fiveMbLength),
  };
});

AfterSuite(async ({ files, indexd, dataUpload }) => {
  // delete the temp files from local storage
  if (fs.existsSync(filePath)) {
    files.deleteFile(filePath);
  }
  if (fs.existsSync(bigFileName)) {
    files.deleteFile(bigFileName);
  }

  // clean up in indexd and S3 (remove the records created by this test suite)
  // Note: we don't use fence's /delete endpoint here because it does not allow
  // deleting from indexd records that have already been linked to metadata
  await indexd.complete.deleteFiles(createdGuids);
  await dataUpload.cleanS3(fileName, createdGuids);
});

Before(({ nodes }) => {
  // Refresh nodes before every test to clear any appended results, id's, etc
  nodes.refreshPathNodes();
});

After(async ({ sheepdog }) => {
  // clean up in sheepdog
  await sheepdog.complete.findDeleteAllNodes();
});
