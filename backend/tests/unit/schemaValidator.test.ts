import { describe, expect, it } from "vitest";
import {
  assertAttributesValid,
  assertValidSchema,
  validateAttributes,
  type AttributeSchema,
} from "../../src/modules/categories/schemaValidator";

const schema: AttributeSchema = {
  type: "object",
  required: ["has_backrest", "condition"],
  properties: {
    has_backrest: { type: "boolean", label: "是否有靠背" },
    count: { type: "integer", label: "可坐人数", minimum: 1, maximum: 50 },
    condition: { type: "string", label: "完好程度", enum: ["good", "fair", "poor"] },
    good_for: { type: "array", label: "适合做什么", items: { type: "string", enum: ["reading", "rest"] } },
  },
};

describe("动态属性校验", () => {
  it("通过合法属性", () => {
    const result = validateAttributes(schema, {
      has_backrest: true,
      condition: "good",
      count: 3,
      good_for: ["reading"],
    });
    expect(result.ok).toBe(true);
  });

  it("缺少必填项时报出字段路径", () => {
    const result = validateAttributes(schema, { condition: "good" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.field).toBe("attributes.has_backrest");
    expect(result.errors[0]?.rule).toBe("required");
  });

  it("未知字段不会被静默忽略", () => {
    const result = validateAttributes(schema, {
      has_backrest: true,
      condition: "good",
      typo_field: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.rule === "unknown_field")).toBe(true);
  });

  it("数字越界会被拦下", () => {
    const result = validateAttributes(schema, { has_backrest: true, condition: "good", count: 999 });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.rule).toBe("maximum");
  });

  it("枚举之外的取值会被拦下", () => {
    const result = validateAttributes(schema, { has_backrest: true, condition: "broken" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.rule).toBe("enum");
  });

  it("数组里的非法取值会被拦下", () => {
    const result = validateAttributes(schema, {
      has_backrest: true,
      condition: "good",
      good_for: ["reading", "swimming"],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.field).toBe("attributes.good_for");
  });

  it("提交时直接抛出带错误码的异常", () => {
    expect(() => assertAttributesValid(schema, { condition: "good" })).toThrowError(/是否有靠背/);
  });

  it("Schema 本身的结构会被校验", () => {
    expect(() => assertValidSchema({ type: "object", properties: { a: { type: "date" } } })).toThrow();
    expect(() => assertValidSchema({ type: "object", required: ["missing"], properties: {} })).toThrow();
    expect(assertValidSchema(schema)).toBe(schema);
  });
});
