"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

export function StartConfirmation({ open, cancel, confirm }: {
  open: boolean; cancel: () => void; confirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current?.close();
  }, [open]);
  return <dialog ref={dialog} onCancel={cancel} onClose={cancel} aria-labelledby="start-title"
    aria-describedby="start-description" className="m-auto max-w-lg rounded-control border border-line bg-paper p-6 text-ink backdrop:bg-ink/40"
    style={{ width: "calc(100% - 2rem)" }}>
    <p className="eyebrow">A shared beginning</p>
    <h2 id="start-title" className="mt-3 text-2xl font-semibold">Ready to start training?</h2>
    <p id="start-description" className="mt-4 leading-relaxed text-muted">New participants won’t be able to join after training begins. Everyone already in this room will move to Training Preparation together. You can also begin on your own.</p>
    <div className="mt-6 flex flex-col gap-3 sm:flex-row">
      <Button variant="secondary" onClick={cancel} autoFocus>Keep gathering</Button>
      <Button onClick={confirm}>Yes, start training</Button>
    </div>
  </dialog>;
}
