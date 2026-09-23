import type {
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter"
import { mkdirSync, writeFileSync } from "node:fs"
/** Avoid request traces and redact generated test passwords from failure call logs. */
export default class SafeReporter implements Reporter {
  private results: { title: string; status: string; errors: string[] }[] = []
  private safe(value: string) {
    return value.replace(/E2E-pass-[a-f0-9-]+!/gi, "[REDACTED]")
  }
  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep) {
    if (step.category === "test.step")
      console.log(`${step.error ? "FAIL" : "PASS"}: ${step.title}`)
  }
  onTestEnd(test: TestCase, result: TestResult) {
    const errors = result.errors.map((error) =>
      this.safe(error.message ?? "Test failed")
    )
    this.results.push({ title: test.title, status: result.status, errors })
    console.log(`${result.status}: ${test.title}`)
    errors.forEach((error) => console.log(error))
  }
  onEnd() {
    mkdirSync("playwright-report", { recursive: true })
    writeFileSync(
      "playwright-report/results.json",
      JSON.stringify(this.results, null, 2)
    )
  }
}
