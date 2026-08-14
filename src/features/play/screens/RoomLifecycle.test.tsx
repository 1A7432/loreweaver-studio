import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import { useAdminStore } from "../../../store/admin"
import { useConnectionStore } from "../../../store/connection"
import RoomLifecycle from "./RoomLifecycle"

const WELCOME = {
  type: "welcome" as const,
  protocol: "2.1",
  room: "table",
  you: { id: "u1", name: "keeper", role: "keeper" as const },
  locale: "en",
  server: "loreweaver/1",
}

function connected(features: string[] = []) {
  useConnectionStore.setState({ status: "online", welcome: { ...WELCOME, features } })
}

/** The four destructive actions, in DOM order — each owns one confirm field. */
const DANGER = { restore: 0, reset: 1, deleteData: 2, deleteKeys: 3 } as const

async function confirmAction(which: keyof typeof DANGER, label: string) {
  await userEvent.type(screen.getAllByLabelText("Type “table” to confirm")[DANGER[which]], "table")
  await userEvent.click(screen.getByRole("button", { name: label }))
}

describe("RoomLifecycle", () => {
  beforeEach(() => {
    useAdminStore.getState().reset()
    connected()
  })

  it("exports with the server's own default path when none is given", async () => {
    const exportRoom = vi.fn()
    useAdminStore.setState({ exportRoom })
    render(<RoomLifecycle />)
    await userEvent.click(screen.getByRole("button", { name: "Write a backup" }))
    // `undefined`, not "": the protocol says an omitted path lets the server
    // choose, under <data_dir>/room_backups/.
    expect(exportRoom).toHaveBeenCalledWith("table", undefined)
  })

  it("arms a destructive action only once the room's name is typed", async () => {
    const deleteRoom = vi.fn()
    useAdminStore.setState({ deleteRoom })
    render(<RoomLifecycle />)

    const button = screen.getByRole("button", { name: "Delete the keys" })
    expect(button).toBeDisabled()

    const field = screen.getAllByLabelText("Type “table” to confirm")[DANGER.deleteKeys]
    await userEvent.type(field, "tabl")
    expect(button).toBeDisabled()
    await userEvent.type(field, "e")
    expect(button).toBeEnabled()
    await userEvent.click(button)
    expect(deleteRoom).toHaveBeenCalledWith("table")
  })

  it("sends the chosen reset scope, and says what that scope keeps", async () => {
    const resetRoom = vi.fn()
    useAdminStore.setState({ resetRoom })
    render(<RoomLifecycle />)

    expect(screen.getByText(/Characters, module, lore and media stay/)).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText("How much"), "all")
    expect(screen.getByText(/Erases everything/)).toBeInTheDocument()

    await confirmAction("reset", "Reset")
    expect(resetRoom).toHaveBeenCalledWith("table", "all")
  })

  it("defaults the pre-delete backup on, and warns when it is turned off", async () => {
    const deleteRoomData = vi.fn()
    useAdminStore.setState({ deleteRoomData })
    render(<RoomLifecycle />)

    const backup = screen.getByRole("checkbox")
    expect(backup).toBeChecked()
    await userEvent.click(backup)
    expect(screen.getByText(/nothing to restore from afterwards/)).toBeInTheDocument()

    await confirmAction("deleteData", "Delete the data")
    expect(deleteRoomData).toHaveBeenCalledWith("table", false)
  })

  it("gates the self-update on the welcome's own feature list", async () => {
    render(<RoomLifecycle />)
    expect(screen.getByRole("button", { name: "Update and restart" })).toBeDisabled()
    expect(screen.getByText(/advertises no update command/)).toBeInTheDocument()

    useAdminStore.getState().reset()
    connected(["update"])
    render(<RoomLifecycle />)
    expect(screen.getAllByRole("button", { name: "Update and restart" }).at(-1)).toBeEnabled()
  })

  it("reports what an operation actually did, with the server's counts", () => {
    useAdminStore.setState({
      roomOp: {
        type: "admin_room_op",
        action: "export",
        room: "table",
        path: "/data/room_backups/table.json",
        keys: 3,
        store_rows: 41,
        vector_points: 12,
      },
    })
    render(<RoomLifecycle />)
    expect(screen.getByRole("status")).toHaveTextContent("/data/room_backups/table.json")
    expect(screen.getByRole("status")).toHaveTextContent("3 key(s), 41 state row(s), 12 vector(s)")
  })

  it("treats a restarting server as success, not as a failure", () => {
    useAdminStore.setState({ serverUpdate: { type: "admin_update", status: "restarting" } })
    render(<RoomLifecycle />)
    const notice = screen.getByRole("status")
    expect(notice).toHaveTextContent(/connection will drop and come back/)
    expect(notice).not.toHaveClass("split-error")
  })
})
