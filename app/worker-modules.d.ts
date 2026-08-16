// Vite's ?worker imports resolve to a Worker constructor; the project does
// not include vite/client types, so the module shape is declared here.
declare module "*?worker" {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
