'use strict';
  
const fence_props = require('./fence_props.js');
const commons_helper = require('../../commons_helper.js');
const portal_helper = require('../../portal/portal_helper.js');

let I = actor();

/**
 * fence Tasks
 */
module.exports = {
  createSignedUrl(id, args=[]) {
    return I.sendGetRequest(
      `${fence_props.endpoints.getFile}/${id}?${args.join('&')}`.replace(/[?]$/g, ''),
      commons_helper.validAccessTokenHeader)
      .then(
      (res) => {
        return res;
      }
    );
  },

  getFile(url) {
    return I.sendGetRequest(url).then( res => res.body);
  },

  createAPIKey(scope, access_token_header) {
    access_token_header['Content-Type'] = 'application/json';
    return I.sendPostRequest(
      fence_props.endpoints.createAPIKey,
      JSON.stringify({
        scope: scope
      }),
      access_token_header)
      .then(
        (res) => res
      );
  },

  deleteAPIKey(api_key) {
    return I.sendDeleteRequest(
      `${fence_props.endpoints.deleteAPIKey}/${api_key}`,
      commons_helper.validAccessTokenHeader)
        .then(
          (res) => res.body
        );
  },

  getAccessToken(api_key) {
    let data = (api_key !== null) ? { api_key: api_key } : {};
    return I.sendPostRequest(
      fence_props.endpoints.getAccessToken,
      JSON.stringify(data),
      commons_helper.validIndexAuthHeader)
        .then(
          (res) => res
        );
  },

  async linkGoogleAcct(linking_acct) {
    // expects that we have already set the access token
    I.seeCookie('access_token');
    // hit link endpoint and wait for redirect to google auth
    I.amOnPage(fence_props.endpoints.linkGoogle);
    portal_helper.seeProp(fence_props.googleLoginReadyCue, 10);

    // fill out username and password
    I.fillField(fence_props.googleEmailField.locator, linking_acct.email);
    portal_helper.clickProp(fence_props.googleEmailNext);
    portal_helper.seeProp(fence_props.googlePasswordReadyCue, 10);
    I.wait(5);
    I.fillField(fence_props.googlePasswordField.locator, linking_acct.password);
    portal_helper.clickProp(fence_props.googlePasswordNext);

    // wait until redirected back to root
    await I.waitInUrl(fence_props.endpoints.root, 5);
    I.wait(5);
    let url = await I.grabCurrentUrl();
    let res = await I.grabSource();
    console.log("link res", res);
    console.log("link url", url);
    // FIXME: Why is access_token not there anymore??
    // I.seeCookie('access_token');
    let access_token;
    try {
      access_token = await I.grabCookie('access_token');
    } catch(e) {
      console.log(e)
    }
    console.log("ACCESS_TOKEN", access_token);
    return {
      body: res,
      url: url,
      //access_token: access_token
    };
  },

  async unlinkGoogleAcct() {
    return I.sendDeleteRequest(fence_props.endpoints.deleteGoogleLink, commons_helper.validAccessTokenHeader)
      .then( (res) => {
        return {
          body: res.body,
          statusCode: res.statusCode
        };
      });
  },

  async extendGoogleLink() {
    I.haveRequestHeaders(commons_helper.validAccessTokenHeader);
    return I.sendPatchRequest(fence_props.endpoints.extendGoogleLink)
      .then( (res) => {
        I.resetRequestHeaders();
        return {
          statusCode: res.statusCode,
          body: res.body
        };
      })
  },

};