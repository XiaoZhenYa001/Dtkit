import assert from 'node:assert/strict';
import test from 'node:test';
import {
    decodeBase64,
    detectCommand,
    encodeBase64,
    evaluateExpression,
    formatNumber,
    parseCountdown,
    transformText
} from '../src/quick/commandEngine.js';

test('calculator evaluates arithmetic without dynamic code execution', () => {
    assert.equal(evaluateExpression('128 * 36'), 4608);
    assert.equal(evaluateExpression('2 + 3 * (4 - 1)'), 11);
    assert.equal(evaluateExpression('2^3^2'), 512);
    assert.equal(formatNumber(evaluateExpression('1 / 3')), '0.33333333333333');
    assert.throws(() => evaluateExpression('globalThis.process'));
    assert.throws(() => evaluateExpression('1 / 0'), /除以零/);
});

test('countdown parser supports compact Chinese and English units', () => {
    assert.deepEqual(parseCountdown('倒计时 5分钟 喝水'), { seconds: 300, name: '喝水' });
    assert.equal(parseCountdown('timer 1.5 h').seconds, 5400);
    assert.throws(() => parseCountdown('倒计时 25小时'), /24 小时/);
});

test('command detector keeps file search explicitly opt-in', () => {
    assert.deepEqual(detectCommand('> report'), { kind: 'file', query: 'report' });
    assert.deepEqual(detectCommand('文件 budget'), { kind: 'file', query: 'budget' });
    assert.deepEqual(detectCommand('计算 128*36'), { kind: 'calculation', expression: '128*36' });
    assert.equal(detectCommand('json').kind, 'tools');
});

test('text transformations preserve Unicode', () => {
    const encoded = encodeBase64('你好 DtKit');
    assert.equal(decodeBase64(encoded), '你好 DtKit');
    assert.equal(transformText('URL编码', 'a b')[0].value, 'a%20b');
    assert.equal(transformText('编码', '你好').length, 2);
});
