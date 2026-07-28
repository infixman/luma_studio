import { Menu, MenuCheckItem, MenuGroup } from './Menu'
import { choosableColumns, toggleHidden, type ColumnSpec } from './columns'

/**
 * A checkbox list of the columns, behind one button.
 *
 * Columns marked `fixed` are not in the list at all rather than in it and
 * greyed out: a disabled checkbox invites people to work out why, and the
 * answer — "a row with no id is a row you cannot act on" — is not worth a
 * tooltip on every list in the back office.
 *
 * The choice is remembered per page by whoever owns the state; this component
 * only draws it.
 */
export function ColumnChooser({
  columns,
  hidden,
  onChange,
}: {
  columns: ColumnSpec[]
  hidden: string[]
  onChange: (hidden: string[]) => void
}) {
  const offered = choosableColumns(columns)
  if (offered.length === 0) return null

  const shown = offered.length - offered.filter((column) => hidden.includes(column.key)).length

  return (
    <Menu
      label="欄位顯示設定"
      variant="button"
      trigger={
        <>
          <Columns />
          欄位 {shown}/{offered.length}
        </>
      }
    >
      <MenuGroup label="要顯示的欄位" />
      {offered.map((column) => (
        <MenuCheckItem
          key={column.key}
          checked={!hidden.includes(column.key)}
          onChange={() => onChange(toggleHidden(columns, hidden, column.key))}
        >
          {column.label}
        </MenuCheckItem>
      ))}
    </Menu>
  )
}

function Columns() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5h16v14H4zM10 5v14M16 5v14" />
    </svg>
  )
}
