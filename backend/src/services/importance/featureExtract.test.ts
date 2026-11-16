import assert from 'assert';
import { computePolicyStarFloor } from './featureExtract';

function testPolicyPublishFloor() {
  const r = computePolicyStarFloor('国家发改委印发碳达峰实施方案');
  assert.strictEqual(r.floor_stars, 5);
  assert.strictEqual(r.reason, 'policy_publish');
  assert.ok(r.matched_agencies.length > 0);
}

function testEnergyBureauPlan() {
  const r = computePolicyStarFloor('国家能源局发布新能源发展规划');
  assert.strictEqual(r.floor_stars, 5);
  assert.strictEqual(r.reason, 'policy_publish');
}

function testMeetingLowerFloor() {
  const r = computePolicyStarFloor('发改委主任主持召开经济形势座谈会');
  assert.strictEqual(r.floor_stars, 4);
  assert.strictEqual(r.reason, 'agency_meeting');
}

function testPressConferenceNotPolicy() {
  const r = computePolicyStarFloor('发改委召开新闻发布会介绍经济运行情况');
  assert.strictEqual(r.floor_stars, 4);
  assert.strictEqual(r.reason, 'agency_meeting');
}

function testMeetingNoticeNotTop() {
  const r = computePolicyStarFloor('发改委关于召开座谈会的通知');
  assert.strictEqual(r.floor_stars, 4);
  assert.strictEqual(r.reason, 'agency_meeting');
}

function testLocalAgencySkipped() {
  const r = computePolicyStarFloor('广东省发改委印发数字经济实施方案');
  assert.strictEqual(r.floor_stars, null);
  assert.strictEqual(r.skipped_local, true);
}

function testNationalOverridesLocalPrefix() {
  const r = computePolicyStarFloor('国家发改委与广东省发改委联合印发方案');
  assert.strictEqual(r.floor_stars, 5);
  assert.strictEqual(r.skipped_local, false);
}

function testNoAgencyNoFloor() {
  const r = computePolicyStarFloor('某企业发布年度发展规划');
  assert.strictEqual(r.floor_stars, null);
}

function run() {
  testPolicyPublishFloor();
  testEnergyBureauPlan();
  testMeetingLowerFloor();
  testPressConferenceNotPolicy();
  testMeetingNoticeNotTop();
  testLocalAgencySkipped();
  testNationalOverridesLocalPrefix();
  testNoAgencyNoFloor();
  console.log('featureExtract policy floor tests passed');
}

run();
