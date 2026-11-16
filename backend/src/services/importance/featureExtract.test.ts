import assert from 'assert';
import { evaluateStarFloorRules, getDefaultStarFloorRules } from './starFloorRules';

const defaults = getDefaultStarFloorRules();

function evalTitle(title: string) {
  return evaluateStarFloorRules(title, defaults);
}

function testPolicyPublishFloor() {
  const r = evalTitle('国家发改委印发碳达峰实施方案');
  assert.strictEqual(r.floor_stars, 5);
  assert.ok(r.matched_rules.some((x) => x.rule_key === 'policy_publish_strong'));
}

function testEnergyBureauPlan() {
  const r = evalTitle('国家能源局发布新能源发展规划');
  assert.strictEqual(r.floor_stars, 5);
}

function testMeetingLowerFloor() {
  const r = evalTitle('发改委主任主持召开经济形势座谈会');
  assert.strictEqual(r.floor_stars, 4);
  assert.ok(r.matched_rules.some((x) => x.rule_key === 'agency_meeting'));
}

function testPressConferenceNotPolicy() {
  const r = evalTitle('发改委召开新闻发布会介绍经济运行情况');
  assert.strictEqual(r.floor_stars, 4);
}

function testMeetingNoticeNotTop() {
  const r = evalTitle('发改委关于召开座谈会的通知');
  assert.strictEqual(r.floor_stars, 4);
}

function testLocalAgencySkipped() {
  const r = evalTitle('广东省发改委印发数字经济实施方案');
  assert.strictEqual(r.floor_stars, null);
  assert.ok(r.skipped_local_keys.length > 0);
}

function testNationalOverridesLocalPrefix() {
  const r = evalTitle('国家发改委与广东省发改委联合印发方案');
  assert.strictEqual(r.floor_stars, 5);
}

function testFedHike() {
  const r = evalTitle('美联储宣布加息25个基点');
  assert.strictEqual(r.floor_stars, 5);
  assert.ok(r.matched_rules.some((x) => x.rule_key === 'cb_decision'));
}

function testNfpPrint() {
  const r = evalTitle('美国非农就业数据公布超预期');
  assert.strictEqual(r.floor_stars, 5);
  assert.ok(r.matched_rules.some((x) => x.rule_key === 'macro_print'));
}

function testNfpPreview() {
  const r = evalTitle('华尔街预测本月非农就业人数');
  assert.strictEqual(r.floor_stars, 4);
  assert.ok(r.matched_rules.some((x) => x.rule_key === 'macro_preview'));
}

function testWar() {
  const r = evalTitle('突发：两国边境爆发全面军事冲突');
  assert.strictEqual(r.floor_stars, 5);
}

function testEarthquake() {
  const r = evalTitle('日本海域发生7.1级地震并发布海啸预警');
  assert.strictEqual(r.floor_stars, 5);
}

function testNoAgencyNoFloor() {
  const r = evalTitle('某企业发布年度发展规划');
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
  testFedHike();
  testNfpPrint();
  testNfpPreview();
  testWar();
  testEarthquake();
  testNoAgencyNoFloor();
  console.log('star floor rule tests passed');
}

run();
