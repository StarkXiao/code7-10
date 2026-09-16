import { AppError } from "../../utils/errors";
import { ERROR_CODES } from "../../config/constants";

/**
 * 属性 Schema 采用精简版 JSON Schema：
 * { type:'object', required:[...], properties:{ key:{ type, label, enum, enumLabels, minimum, maximum, unit, help, ui } } }
 *
 * 只支持够用的字段类型，保持可读与可配置。
 * 这里做的是**严格校验**：未知字段同样报错，避免前端拼错字段名后静默丢数据。
 */
export interface AttributeProperty {
  type: "boolean" | "integer" | "number" | "string" | "array";
  label?: string;
  help?: string;
  ui?: string;
  unit?: string;
  enum?: string[];
  enumLabels?: Record<string, string>;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  // 数组型属性（如"适合做什么"）需要自己的标签映射，
  // 否则前端只能显示 phone_call 这种原始值
  items?: { type: string; enum?: string[]; enumLabels?: Record<string, string> };
}

export interface AttributeSchema {
  type: "object";
  required?: string[];
  properties: Record<string, AttributeProperty>;
}

export function isAttributeSchema(value: unknown): value is AttributeSchema {
  if (!value || typeof value !== "object") return false;
  const schema = value as AttributeSchema;
  return schema.type === "object" && Boolean(schema.properties) && typeof schema.properties === "object";
}

export interface AttributeValidationResult {
  ok: boolean;
  errors: Array<{ field: string; rule: string; message: string }>;
}

export function validateAttributes(
  schema: AttributeSchema,
  attributes: Record<string, unknown>,
): AttributeValidationResult {
  const errors: AttributeValidationResult["errors"] = [];
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  for (const field of required) {
    const value = attributes[field];
    if (value === undefined || value === null || value === "") {
      errors.push({
        field: `attributes.${field}`,
        rule: "required",
        message: `缺少必填属性：${properties[field]?.label ?? field}`,
      });
    }
  }

  for (const [field, value] of Object.entries(attributes)) {
    const property = properties[field];
    if (!property) {
      errors.push({
        field: `attributes.${field}`,
        rule: "unknown_field",
        message: `未知属性：${field}`,
      });
      continue;
    }
    if (value === undefined || value === null || value === "") continue;

    const label = property.label ?? field;

    switch (property.type) {
      case "boolean": {
        if (typeof value !== "boolean") {
          errors.push({ field: `attributes.${field}`, rule: "type", message: `${label} 需要是布尔值` });
        }
        break;
      }
      case "integer":
      case "number": {
        if (typeof value !== "number" || Number.isNaN(value)) {
          errors.push({ field: `attributes.${field}`, rule: "type", message: `${label} 需要是数字` });
          break;
        }
        if (property.type === "integer" && !Number.isInteger(value)) {
          errors.push({ field: `attributes.${field}`, rule: "type", message: `${label} 需要是整数` });
        }
        if (property.minimum !== undefined && value < property.minimum) {
          errors.push({
            field: `attributes.${field}`,
            rule: "minimum",
            message: `${label} 不能小于 ${property.minimum}`,
          });
        }
        if (property.maximum !== undefined && value > property.maximum) {
          errors.push({
            field: `attributes.${field}`,
            rule: "maximum",
            message: `${label} 不能大于 ${property.maximum}`,
          });
        }
        break;
      }
      case "string": {
        if (typeof value !== "string") {
          errors.push({ field: `attributes.${field}`, rule: "type", message: `${label} 需要是文本` });
          break;
        }
        if (property.enum && !property.enum.includes(value)) {
          errors.push({
            field: `attributes.${field}`,
            rule: "enum",
            message: `${label} 的取值不在允许范围内`,
          });
        }
        if (property.maxLength && value.length > property.maxLength) {
          errors.push({
            field: `attributes.${field}`,
            rule: "maxLength",
            message: `${label} 最多 ${property.maxLength} 个字符`,
          });
        }
        break;
      }
      case "array": {
        if (!Array.isArray(value)) {
          errors.push({ field: `attributes.${field}`, rule: "type", message: `${label} 需要是数组` });
          break;
        }
        const allowed = property.items?.enum;
        if (allowed) {
          const invalid = value.filter((item) => !allowed.includes(String(item)));
          if (invalid.length > 0) {
            errors.push({
              field: `attributes.${field}`,
              rule: "enum",
              message: `${label} 含有无效取值：${invalid.join("、")}`,
            });
          }
        }
        break;
      }
      default: {
        errors.push({ field: `attributes.${field}`, rule: "schema", message: `${label} 的字段类型不受支持` });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** 属性 Schema 本身的结构校验（管理员配置时使用） */
export function assertValidSchema(schema: unknown): AttributeSchema {
  if (!isAttributeSchema(schema)) {
    throw AppError.badRequest("属性 Schema 必须是 { type:'object', properties:{...} } 结构");
  }

  const supported = new Set(["boolean", "integer", "number", "string", "array"]);
  for (const [field, property] of Object.entries(schema.properties)) {
    if (!property || typeof property !== "object") {
      throw AppError.badRequest(`属性 ${field} 的定义不合法`);
    }
    if (!supported.has(property.type)) {
      throw AppError.badRequest(`属性 ${field} 使用了不支持的类型：${property.type}`);
    }
    if (property.type === "string" && property.enum && property.enum.length === 0) {
      throw AppError.badRequest(`属性 ${field} 的枚举值为空`);
    }
  }

  for (const field of schema.required ?? []) {
    if (!schema.properties[field]) {
      throw AppError.badRequest(`必填字段 ${field} 没有对应的属性定义`);
    }
  }

  return schema;
}

export function assertAttributesValid(
  schema: AttributeSchema,
  attributes: Record<string, unknown>,
): void {
  const result = validateAttributes(schema, attributes);
  if (!result.ok) {
    const first = result.errors[0]!;
    throw AppError.unprocessable(ERROR_CODES.SPOT_ATTRIBUTE_REQUIRED, first.message, result.errors);
  }
}
