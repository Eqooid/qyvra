import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

/** Exercise the real calendar through its accessible navigation and day buttons. */
export async function chooseDate(label: string, date: string) {
  const user = userEvent.setup()
  const trigger = screen.getByRole("button", { name: label })
  const previous = trigger.textContent?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0]
  const displayed = previous ? new Date(`${previous}T12:00:00`) : new Date()
  const target = new Date(`${date}T12:00:00`)
  const difference =
    (target.getFullYear() - displayed.getFullYear()) * 12 +
    target.getMonth() -
    displayed.getMonth()
  await user.click(trigger)
  for (let index = 0; index < Math.abs(difference); index++) {
    await user.click(
      screen.getByRole("button", {
        name:
          difference < 0 ? "Go to the Previous Month" : "Go to the Next Month",
      })
    )
  }
  const month = target.toLocaleString("en", { month: "long" })
  await user.click(
    screen.getByRole("button", {
      name: new RegExp(
        `${month} ${target.getDate()}(?:st|nd|rd|th)?, ${target.getFullYear()}`
      ),
    })
  )
}
