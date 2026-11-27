import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { UpdateInfo } from "@main/shared/types";
import { invoke, onNotification } from "./bridge";

const UPDATE_KEY = ["update"] as const;

/** What the daily update check found; refreshed whenever main announces a change. */
export function useUpdateInfo() {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      onNotification<UpdateInfo>("update:changed", (info) =>
        queryClient.setQueryData(UPDATE_KEY, info),
      ),
    [queryClient],
  );
  return useQuery({ queryKey: UPDATE_KEY, queryFn: () => invoke<UpdateInfo>("update:get") });
}

/** Check GitHub now, even if a check already ran today. */
export function useCheckForUpdates() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => invoke<UpdateInfo>("update:check"),
    onSuccess: (info) => queryClient.setQueryData(UPDATE_KEY, info),
  });
}

export function useSetAutoUpdateCheck() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => invoke<UpdateInfo>("update:setAuto", { enabled }),
    onSuccess: (info) => queryClient.setQueryData(UPDATE_KEY, info),
  });
}

/** Opens a release page or installer in the browser (main only allows Wefty's own). */
export function openUpdateLink(url: string): Promise<void> {
  return invoke<void>("update:open", { url });
}
