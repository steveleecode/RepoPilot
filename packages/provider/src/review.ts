import { z } from "zod";

const reference = z.strictObject({
  file: z.string().min(1).max(500),
  line: z.number().int().positive(),
  description: z.string().trim().min(1).max(1_000)
});

// A model may provide evidence-backed judgment, never executable verification.
export const independentReviewSchema = z.strictObject({
  summary: z.string().trim().min(1).max(5_000),
  findings: z
    .array(
      z.strictObject({
        file: z.string().min(1).max(500),
        line: z.number().int().positive(),
        severity: z.enum(["high", "medium", "low"]),
        description: z.string().trim().min(1).max(2_000),
        evidence: z.array(reference).min(1).max(5),
        suggestedFix: z.string().trim().min(1).max(2_000),
        verificationStatus: z.literal("unverified")
      })
    )
    .max(30),
  criteria: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(100),
        status: z.enum(["supported", "not_met", "unverified"]),
        evidence: z.array(reference).max(5)
      })
    )
    .min(1)
    .max(30)
});

export type IndependentReview = z.infer<typeof independentReviewSchema>;

export function validateIndependentReview(
  value: unknown,
  criteriaIds: string[],
  files: { path: string; lines: number }[]
): IndependentReview {
  const review = independentReviewSchema.parse(value);
  const expected = new Set(criteriaIds);
  if (
    review.criteria.length !== expected.size ||
    new Set(review.criteria.map((item) => item.id)).size !== expected.size ||
    review.criteria.some((item) => !expected.has(item.id))
  ) {
    throw new Error("Review must assess every acceptance criterion exactly once.");
  }
  const known = new Map(files.map((file) => [file.path, file.lines]));
  const checkReference = (ref: { file: string; line: number }) => {
    const lines = known.get(ref.file);
    if (lines === undefined || ref.line > lines)
      throw new Error("Review cites unknown file or line evidence.");
  };
  for (const finding of review.findings) {
    checkReference(finding);
    finding.evidence.forEach(checkReference);
  }
  for (const criterion of review.criteria) {
    if (criterion.status !== "unverified" && criterion.evidence.length === 0)
      throw new Error("Review judgment requires file and line evidence.");
    criterion.evidence.forEach(checkReference);
  }
  return review;
}
