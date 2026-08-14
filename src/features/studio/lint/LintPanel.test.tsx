import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import "../../../i18n"
import LintPanel, { LintBadge } from "./LintPanel"
import type { PackLintFinding } from "./model"

const FINDINGS: PackLintFinding[] = [
  {
    ruleId: "panelBindsHiddenVariable",
    severity: "warn",
    key: "panelBindsHiddenVariable",
    params: { panel: "hud", id: "truth" },
    target: { kind: "panel", id: "hud" },
  },
  {
    ruleId: "variableUnused",
    severity: "info",
    key: "variableUnused",
    params: { id: "fear" },
    target: { kind: "variable", id: "fear" },
  },
]

describe("LintPanel", () => {
  it("renders each finding's localized message", () => {
    render(<LintPanel findings={FINDINGS} />)
    expect(screen.getByText(/hud/)).toBeInTheDocument()
    expect(screen.getByText(/fear/)).toBeInTheDocument()
    expect(screen.getByText(/1 warning\(s\), 1 note\(s\)/)).toBeInTheDocument()
  })

  it("says so when there is nothing to report", () => {
    render(<LintPanel findings={[]} />)
    expect(screen.getByRole("status")).toHaveTextContent("Lint clean")
  })

  it("collapses on request without hiding the count", async () => {
    render(<LintPanel findings={FINDINGS} collapsible />)
    expect(screen.queryByText(/hud/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Show" }))
    expect(screen.getByText(/hud/)).toBeInTheDocument()
  })
})

describe("LintBadge", () => {
  it("marks warnings and opens the panel on click", async () => {
    const onClick = vi.fn()
    render(<LintBadge findings={FINDINGS} onClick={onClick} />)
    const badge = screen.getByRole("button")
    expect(badge).toHaveClass("has-issues")
    await userEvent.click(badge)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("stays plain when only notes remain — the lint never nags", () => {
    render(<LintBadge findings={[FINDINGS[1]]} onClick={() => {}} />)
    expect(screen.getByRole("button")).not.toHaveClass("has-issues")
  })
})
