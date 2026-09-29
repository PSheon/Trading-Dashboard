import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function ComingSoon({
  title,
  prdId,
  description,
}: {
  title: string;
  prdId?: string;
  description?: string;
}) {
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>
          {title}
          {prdId ? (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({prdId})
            </span>
          ) : null}
        </CardTitle>
        <CardDescription>
          {description ??
            "Coming soon — this page is a placeholder from the M1 scaffold. Engine work (Watcher, Scheduler, Rules) lands first per PRD §9."}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
