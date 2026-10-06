// A fixture for test/server-components-button.test.ts: a server file (no
// client directive) that imports Button, which the rule must report.
import { Button } from "@/components/ui/button";

export default function Page() {
  return <Button>never in a server component</Button>;
}
