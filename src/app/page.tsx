import { redirect } from "next/navigation.js";

/** The root route has no content of its own — it redirects to the document screen (Screen 1). */
export default function RootPage() {
  redirect("/documents");
}
