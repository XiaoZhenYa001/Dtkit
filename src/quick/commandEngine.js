const MAX_EXPRESSION_LENGTH = 160;

class ExpressionParser {
    constructor(source) {
        this.source = source.replaceAll('×', '*').replaceAll('÷', '/');
        this.index = 0;
    }

    parse() {
        const value = this.parseAdditive();
        this.skipSpaces();
        if (this.index !== this.source.length) throw new Error('包含无法识别的字符');
        if (!Number.isFinite(value) || Math.abs(value) > 1e100) throw new Error('计算结果超出范围');
        return value;
    }

    skipSpaces() {
        while (/\s/.test(this.source[this.index] || '')) this.index += 1;
    }

    take(operator) {
        this.skipSpaces();
        if (this.source.startsWith(operator, this.index)) {
            this.index += operator.length;
            return true;
        }
        return false;
    }

    parseAdditive() {
        let value = this.parseMultiplicative();
        while (true) {
            if (this.take('+')) value += this.parseMultiplicative();
            else if (this.take('-')) value -= this.parseMultiplicative();
            else return value;
        }
    }

    parseMultiplicative() {
        let value = this.parsePower();
        while (true) {
            if (this.take('*')) value *= this.parsePower();
            else if (this.take('/')) {
                const divisor = this.parsePower();
                if (divisor === 0) throw new Error('不能除以零');
                value /= divisor;
            } else if (this.take('%')) {
                const divisor = this.parsePower();
                if (divisor === 0) throw new Error('不能除以零');
                value %= divisor;
            } else return value;
        }
    }

    parsePower() {
        const value = this.parseUnary();
        return this.take('^') ? value ** this.parsePower() : value;
    }

    parseUnary() {
        if (this.take('+')) return this.parseUnary();
        if (this.take('-')) return -this.parseUnary();
        return this.parsePrimary();
    }

    parsePrimary() {
        if (this.take('(')) {
            const value = this.parseAdditive();
            if (!this.take(')')) throw new Error('缺少右括号');
            return value;
        }
        this.skipSpaces();
        const match = this.source.slice(this.index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
        if (!match) throw new Error('这里需要一个数字');
        this.index += match[0].length;
        return Number(match[0]);
    }
}

export function evaluateExpression(source) {
    const expression = String(source || '').trim();
    if (!expression) throw new Error('请输入算式');
    if (expression.length > MAX_EXPRESSION_LENGTH) throw new Error('算式过长');
    return new ExpressionParser(expression).parse();
}

export function formatNumber(value) {
    if (Number.isInteger(value)) return String(value);
    return Number(value.toPrecision(14)).toString();
}

export function parseCountdown(source) {
    const text = String(source || '').trim();
    const match = text.match(/^(?:倒计时|timer)\s*(\d+(?:\.\d+)?)\s*(秒|秒钟|s|分钟|分|min|m|小时|时|h)(?:\s+(.+))?$/i);
    if (!match) return null;
    const multipliers = { 秒: 1, 秒钟: 1, s: 1, 分钟: 60, 分: 60, min: 60, m: 60, 小时: 3600, 时: 3600, h: 3600 };
    const seconds = Math.round(Number(match[1]) * multipliers[match[2].toLowerCase()]);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400) {
        throw new Error('倒计时必须在 1 秒到 24 小时之间');
    }
    return { seconds, name: match[3]?.trim() || `${match[1]} ${match[2]}倒计时` };
}

function bytesToBinary(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return binary;
}

export function encodeBase64(value) {
    return btoa(bytesToBinary(new TextEncoder().encode(String(value))));
}

export function decodeBase64(value) {
    const binary = atob(String(value).trim());
    return new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(binary, character => character.charCodeAt(0))
    );
}

export function detectCommand(rawQuery) {
    const query = String(rawQuery || '').trim();
    if (!query) return { kind: 'home' };
    if (query.startsWith('>')) return { kind: 'file', query: query.slice(1).trim() };
    if (/^文件\s+/i.test(query)) return { kind: 'file', query: query.replace(/^文件\s+/i, '') };

    const countdown = parseCountdown(query);
    if (countdown) return { kind: 'countdown', ...countdown };

    const calculation = query.match(/^(?:=|计算\s+)(.+)$/i);
    if (calculation) return { kind: 'calculation', expression: calculation[1].trim() };

    const transformation = query.match(/^(URL编码|URL解码|Base64编码|Base64解码|编码|解码)\s+([\s\S]+)$/i);
    if (transformation) {
        return { kind: 'transform', operation: transformation[1].toLowerCase(), value: transformation[2] };
    }
    return { kind: 'tools', query };
}

export function transformText(operation, value) {
    switch (operation.toLowerCase()) {
        case 'url编码': return [{ label: 'URL 编码', value: encodeURIComponent(value) }];
        case 'url解码': return [{ label: 'URL 解码', value: decodeURIComponent(value) }];
        case 'base64编码': return [{ label: 'Base64 编码', value: encodeBase64(value) }];
        case 'base64解码': return [{ label: 'Base64 解码', value: decodeBase64(value) }];
        case '编码': return [
            { label: 'URL 编码', value: encodeURIComponent(value) },
            { label: 'Base64 编码', value: encodeBase64(value) }
        ];
        case '解码': {
            const results = [];
            try { results.push({ label: 'URL 解码', value: decodeURIComponent(value) }); } catch { /* ignore invalid candidate */ }
            try { results.push({ label: 'Base64 解码', value: decodeBase64(value) }); } catch { /* ignore invalid candidate */ }
            if (!results.length) throw new Error('内容不是有效的 URL 或 Base64 编码');
            return results;
        }
        default: throw new Error('不支持的编码操作');
    }
}
