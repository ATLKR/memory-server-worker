export interface UiRequestContext {
  memoryApi: Fetcher;
}
declare module "@tanstack/react-start" {
  interface Register {
    server: {
      requestContext: UiRequestContext;
    };
  }
}
