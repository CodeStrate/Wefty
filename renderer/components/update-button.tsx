import { ArrowDownToLine } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  toast,
} from "@renderer/ui";

import { openUpdateLink, useUpdateInfo } from "../lib/update-api";
import { errorMessage } from "./detail/detail-parts";

/**
 * Sits with the sidebar's toolbar buttons only while a newer Wefty is out: the same quiet
 * icon as its neighbours, plus an accent dot. Its menu offers the download and the notes.
 */
export function UpdateButton() {
  const update = useUpdateInfo().data?.available;
  if (!update) return null;
  const open = (url: string) =>
    void openUpdateLink(url).catch((error: unknown) =>
      toast.error(`Couldn't open the link: ${errorMessage(error)}`),
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Wefty ${update.version} is available`}
          title={`Wefty ${update.version} is available`}
          className="relative"
        >
          <ArrowDownToLine />
          <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-accent" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Wefty {update.version} is available</DropdownMenuLabel>
        <DropdownMenuItem icon="arrow.down.to.line" onSelect={() => open(update.downloadUrl)}>
          Download
        </DropdownMenuItem>
        <DropdownMenuItem icon="sparkles" onSelect={() => open(update.notesUrl)}>
          What's New
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
