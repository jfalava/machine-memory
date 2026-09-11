import { mount } from "@cloudflare/nimbus-docs/client";

mount("[data-dialog-close]", (btn) => {
  const handleClose = () => btn.closest("dialog")?.close();
  btn.addEventListener("click", handleClose);
  return () => btn.removeEventListener("click", handleClose);
});
