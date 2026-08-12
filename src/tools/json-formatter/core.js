import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { parseDocument, stringify as stringifyYaml } from 'yaml';

export const DATA_FORMATS = Object.freeze({
    AUTO: 'auto',
    JSON: 'json',
    YAML: 'yaml',
    XML: 'xml'
});

export const MAX_INPUT_CHARACTERS = 5 * 1024 * 1024;
export const MAX_OUTPUT_CHARACTERS = 12 * 1024 * 1024;

const FORMAT_VALUES = new Set(Object.values(DATA_FORMATS));
const XML_NAME_PATTERN = /^[A-Za-z_\p{L}][\w.\-:\p{L}\p{N}]*$/u;
const XML_METADATA_KEYS = new Set(['#text']);
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class DataConversionError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'DataConversionError';
        this.format = details.format || null;
        this.line = Number.isFinite(details.line) ? details.line : null;
        this.column = Number.isFinite(details.column) ? details.column : null;
        this.excerpt = details.excerpt || '';
    }
}

export function normalizeFormat(format, allowAuto = true) {
    const value = String(format || '').toLowerCase();
    if (!FORMAT_VALUES.has(value) || (!allowAuto && value === DATA_FORMATS.AUTO)) {
        throw new DataConversionError(`不支持的数据格式：${format || '未知'}`);
    }
    return value;
}

export function detectDataFormat(source) {
    const text = stripBom(source).trimStart();
    if (!text) return null;
    if (text.startsWith('<')) return DATA_FORMATS.XML;
    if (text.startsWith('{') || text.startsWith('[')) return DATA_FORMATS.JSON;
    return DATA_FORMATS.YAML;
}

function stripBom(source) {
    const text = String(source ?? '');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function positionToLineColumn(source, position) {
    const safePosition = Math.max(0, Math.min(source.length, position));
    const before = source.slice(0, safePosition);
    const lines = before.split(/\r\n|\r|\n/);
    return { line: lines.length, column: (lines.at(-1)?.length || 0) + 1 };
}

function excerptAt(source, line) {
    if (!Number.isFinite(line) || line < 1) return '';
    return source.split(/\r\n|\r|\n/)[line - 1]?.slice(0, 240) || '';
}

function jsonErrorDetails(source, error) {
    const message = String(error?.message || error);
    const positionMatch = message.match(/position\s+(\d+)/i);
    const lineColumnMatch = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    let line = null;
    let column = null;
    if (positionMatch) ({ line, column } = positionToLineColumn(source, Number(positionMatch[1])));
    if (lineColumnMatch) {
        line = Number(lineColumnMatch[1]);
        column = Number(lineColumnMatch[2]);
    }
    return { line, column, excerpt: excerptAt(source, line) };
}

function parseJson(source) {
    try {
        return JSON.parse(source);
    } catch (error) {
        throw new DataConversionError(`JSON 解析失败：${error.message}`, {
            format: DATA_FORMATS.JSON,
            ...jsonErrorDetails(source, error)
        });
    }
}

function parseYaml(source) {
    const document = parseDocument(source, {
        schema: 'core',
        prettyErrors: true,
        strict: true,
        uniqueKeys: true
    });
    const issue = document.errors[0];
    if (issue) {
        const line = issue.linePos?.[0]?.line ?? null;
        const column = issue.linePos?.[0]?.col ?? null;
        throw new DataConversionError(`YAML 解析失败：${issue.message}`, {
            format: DATA_FORMATS.YAML,
            line,
            column,
            excerpt: excerptAt(source, line)
        });
    }
    try {
        return document.toJS({ maxAliasCount: 100 });
    } catch (error) {
        throw new DataConversionError(`YAML 解析失败：${error.message}`, {
            format: DATA_FORMATS.YAML
        });
    }
}

function parseXml(source) {
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
        throw new DataConversionError('XML 解析失败：出于安全考虑，不支持 DOCTYPE 或自定义实体声明。', {
            format: DATA_FORMATS.XML
        });
    }
    const validation = XMLValidator.validate(source, { allowBooleanAttributes: false });
    if (validation !== true) {
        const line = validation.err?.line ?? null;
        const column = validation.err?.col ?? null;
        throw new DataConversionError(`XML 解析失败：${validation.err?.msg || '文档结构无效'}`, {
            format: DATA_FORMATS.XML,
            line,
            column,
            excerpt: excerptAt(source, line)
        });
    }
    try {
        return new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
            textNodeName: '#text',
            parseTagValue: true,
            parseAttributeValue: false,
            trimValues: true,
            processEntities: false,
            ignoreDeclaration: true,
            ignorePiTags: true,
            maxNestedTags: 120
        }).parse(source);
    } catch (error) {
        throw new DataConversionError(`XML 解析失败：${error.message}`, {
            format: DATA_FORMATS.XML
        });
    }
}

export function parseData(source, format = DATA_FORMATS.AUTO) {
    const text = stripBom(source);
    if (!text.trim()) throw new DataConversionError('请输入需要转换的内容。');
    if (text.length > MAX_INPUT_CHARACTERS) {
        throw new DataConversionError('输入超过 5 MB 安全上限，请拆分后再转换。');
    }
    const requestedFormat = normalizeFormat(format);
    const detectedFormat = requestedFormat === DATA_FORMATS.AUTO
        ? detectDataFormat(text)
        : requestedFormat;
    if (detectedFormat === DATA_FORMATS.JSON) return { value: parseJson(text), detectedFormat };
    if (detectedFormat === DATA_FORMATS.XML) return { value: parseXml(text), detectedFormat };
    return { value: parseYaml(text), detectedFormat: DATA_FORMATS.YAML };
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRootName(rootName) {
    const value = String(rootName || 'root').trim();
    if (!XML_NAME_PATTERN.test(value) || value.toLowerCase().startsWith('xml')) {
        throw new DataConversionError('XML 根节点名称无效，请使用合法标签名且不要以 xml 开头。', {
            format: DATA_FORMATS.XML
        });
    }
    return value;
}

function prepareXmlRoot(value, requestedRootName) {
    if (requestedRootName) {
        return { [normalizeRootName(requestedRootName)]: Array.isArray(value) ? { item: value } : value };
    }
    if (isPlainObject(value)) {
        const rootKeys = Object.keys(value).filter(key => !key.startsWith('@_') && !XML_METADATA_KEYS.has(key));
        if (rootKeys.length === 1 && XML_NAME_PATTERN.test(rootKeys[0]) && !Array.isArray(value[rootKeys[0]])) {
            return value;
        }
        return { root: value };
    }
    if (Array.isArray(value)) return { root: { item: value } };
    return { root: value };
}

function validateXmlObjectKeys(value, path = 'root') {
    if (Array.isArray(value)) {
        value.forEach((item, index) => validateXmlObjectKeys(item, `${path}[${index}]`));
        return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
        const name = key.startsWith('@_') ? key.slice(2) : key;
        if (DANGEROUS_KEYS.has(name) || (!XML_METADATA_KEYS.has(key) && (!XML_NAME_PATTERN.test(name) || name.toLowerCase().startsWith('xml')))) {
            throw new DataConversionError(`无法生成 XML：字段“${key}”不是合法的 XML 节点或属性名称（位置：${path}）。`, {
                format: DATA_FORMATS.XML
            });
        }
        validateXmlObjectKeys(child, `${path}.${key}`);
    }
}

function stringifyJson(value, pretty, indent) {
    const output = JSON.stringify(value, null, pretty ? indent : 0);
    if (output === undefined) throw new DataConversionError('该内容无法转换为 JSON。', { format: DATA_FORMATS.JSON });
    return output;
}

function stringifyXml(value, pretty, indent, rootName) {
    validateXmlObjectKeys(value);
    const body = new XMLBuilder({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        textNodeName: '#text',
        format: pretty,
        indentBy: ' '.repeat(indent),
        suppressEmptyNode: false,
        suppressBooleanAttributes: false,
        processEntities: false
    }).build(prepareXmlRoot(value, rootName));
    return `<?xml version="1.0" encoding="UTF-8"?>${pretty ? '\n' : ''}${body}`;
}

export function stringifyData(value, format, options = {}) {
    const targetFormat = normalizeFormat(format, false);
    const indent = options.indent === 4 ? 4 : 2;
    const pretty = options.pretty !== false;
    let output;
    if (targetFormat === DATA_FORMATS.JSON) output = stringifyJson(value, pretty, indent);
    else if (targetFormat === DATA_FORMATS.XML) output = stringifyXml(value, pretty, indent, options.rootName);
    else {
        output = stringifyYaml(value, {
            indent,
            lineWidth: 0,
            aliasDuplicateObjects: false,
            collectionStyle: pretty ? 'block' : 'flow'
        }).trimEnd();
    }
    if (output.length > MAX_OUTPUT_CHARACTERS) {
        throw new DataConversionError('转换结果超过 12 MB 安全上限，请缩小输入内容。', { format: targetFormat });
    }
    return output;
}

function inspectValue(value) {
    const pending = [{ value, depth: 1 }];
    let nodes = 0;
    let maxDepth = 0;
    while (pending.length) {
        const current = pending.pop();
        nodes += 1;
        maxDepth = Math.max(maxDepth, current.depth);
        if (nodes > 200_000) return { nodes, maxDepth, truncated: true };
        if (current.value && typeof current.value === 'object') {
            for (const child of Object.values(current.value)) {
                pending.push({ value: child, depth: current.depth + 1 });
            }
        }
    }
    return { nodes, maxDepth, truncated: false };
}

export function convertData(request) {
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    const parsed = parseData(request.source, request.sourceFormat);
    const targetFormat = normalizeFormat(request.targetFormat, false);
    const options = { ...request.options };
    if (parsed.detectedFormat === DATA_FORMATS.XML && targetFormat === DATA_FORMATS.XML) {
        options.rootName = undefined;
    }
    const output = stringifyData(parsed.value, targetFormat, options);
    const stats = inspectValue(parsed.value);
    const finishedAt = globalThis.performance?.now?.() ?? Date.now();
    return {
        output,
        detectedFormat: parsed.detectedFormat,
        targetFormat,
        elapsedMs: Math.max(0, Math.round((finishedAt - startedAt) * 10) / 10),
        nodes: stats.nodes,
        maxDepth: stats.maxDepth,
        nodeCountTruncated: stats.truncated
    };
}

export function serializeConversionError(error) {
    return {
        message: error?.message || '转换失败',
        format: error?.format || null,
        line: error?.line || null,
        column: error?.column || null,
        excerpt: error?.excerpt || ''
    };
}
