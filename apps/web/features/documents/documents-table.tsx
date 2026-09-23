"use client"

import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

import Link from "next/link"
import { useMemo, type ReactNode } from "react"
import {
  columnVisibilityFeature,
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table"
import { StatusBadge } from "@/components/shared/status-badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Columns3, FileText } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu"
import type { DocumentItem } from "@/lib/api/documents"

// The API owns filtering, ordering and cursor pagination; render its page unchanged.
const features = tableFeatures({ columnVisibilityFeature })
const column = createColumnHelper<typeof features, DocumentItem>()
const label = (value: string) => value.toLowerCase().replaceAll("_", " ")
const empty: DocumentItem[] = []

export function DocumentsTable({
  data = empty,
  uploadedId,
  toolbar,
  children,
  hideRows = false,
}: {
  data?: DocumentItem[]
  uploadedId?: string
  toolbar?: ReactNode
  children?: ReactNode
  hideRows?: boolean
}) {
  const columns = useMemo(
    () =>
      column.columns([
        column.accessor("title", {
          header: "Document",
          enableHiding: false,
          cell: ({ row }) => (
            <div className="flex w-56 items-start gap-3 whitespace-normal">
              <FileText
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
              />
              <div className="min-w-0 space-y-1 break-words">
                {row.original.id === uploadedId && (
                  <p className="text-xs font-medium text-primary">
                    Just uploaded
                  </p>
                )}
                <Link
                  href={`/documents/${row.original.id}`}
                  className="font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {row.original.title}
                </Link>
                <p className="text-xs text-muted-foreground capitalize">
                  {label(row.original.documentType)}
                </p>
              </div>
            </div>
          ),
        }),
        column.accessor("status", {
          header: "Status",
          enableHiding: false,
          cell: ({ row }) => (
            <div className="flex flex-col items-start gap-1">
              <StatusBadge status={row.original.status}>
                <span className="capitalize">{label(row.original.status)}</span>
              </StatusBadge>
              {row.original.isArchived &&
                row.original.status !== "ARCHIVED" && (
                  <span className="text-xs">Archived</span>
                )}
            </div>
          ),
        }),
        column.accessor((item) => item.category?.name, {
          id: "category",
          header: "Category",
          enableHiding: false,
          cell: ({ getValue }) => (
            <span className="block w-32 break-words whitespace-normal">
              {getValue() || "Uncategorized"}
            </span>
          ),
        }),
        column.accessor("tags", {
          header: "Tags",
          cell: ({ getValue }) => (
            <div className="flex w-40 flex-wrap gap-1 whitespace-normal">
              {getValue().length ? (
                getValue().map((tag) => (
                  <Badge
                    variant="secondary"
                    key={tag.id}
                    className="h-auto max-w-full px-2 py-1 break-words whitespace-normal"
                  >
                    {tag.name}
                  </Badge>
                ))
              ) : (
                <span className="text-muted-foreground">No tags</span>
              )}
            </div>
          ),
        }),
        column.accessor("issuer", {
          header: "Issuer",
          cell: ({ getValue }) => (
            <span className="block w-36 break-words whitespace-normal">
              {getValue() || "Not provided"}
            </span>
          ),
        }),
        column.accessor("documentDate", {
          header: "Document date",
          cell: ({ getValue }) => getValue() || "Not provided",
        }),
        column.accessor("expirationDate", {
          header: "Expiration",
          cell: ({ getValue }) => getValue() || "Not provided",
        }),
        column.accessor("createdAt", {
          header: "Created",
          enableHiding: false,
          cell: ({ getValue }) => (
            <time dateTime={getValue()}>{getValue().slice(0, 10)}</time>
          ),
        }),
      ]),
    [uploadedId]
  )
  const table = useTable({
    features,
    columns,
    data,
    getRowId: (row) => row.id,
    initialState: {
      columnVisibility: {
        issuer: false,
        documentDate: false,
        expirationDate: false,
      },
    },
  })
  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-3">
        {toolbar}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="default" />}
          >
            <Columns3 aria-hidden /> Columns
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {table
              .getAllLeafColumns()
              .filter((item) => item.getCanHide())
              .map((item) => (
                <DropdownMenuCheckboxItem
                  key={item.id}
                  checked={item.getIsVisible()}
                  onCheckedChange={(checked) => item.toggleVisibility(checked)}
                >
                  {String(item.columnDef.header)}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="sr-only" id="document-table-help">
        Scroll horizontally to view all document columns on smaller screens.
      </p>
      {children}
      {!hideRows && (
        <Table
          aria-label="Documents"
          aria-describedby="document-table-help"
          tabIndex={0}
          className="focus-visible:outline-2 focus-visible:outline-ring"
        >
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead key={header.id} scope="col" className="px-4">
                    {header.isPlaceholder ? null : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="px-4 py-4 align-top">
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  )
}
