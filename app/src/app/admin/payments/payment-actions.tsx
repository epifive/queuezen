"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { approvePayment, rejectPayment } from "../actions/payments";

export function PaymentReview({ id }: { id: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  function run(action: (id: number) => Promise<{ error?: string }>, question: string) {
    if (!confirm(question)) return;
    start(async () => {
      const result = await action(id);
      if (result.error) alert(result.error);
      router.refresh();
    });
  }
  return (
    <div className="flex justify-end gap-2">
      <Button size="sm" disabled={pending} onClick={() => run(approvePayment, "Approve this payment and activate the plan?")}>
        Approve
      </Button>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => run(rejectPayment, "Reject this payment?")}>
        Reject
      </Button>
    </div>
  );
}
