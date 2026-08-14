export async function refreshElementSlices({ getElements, loadElements, setElements }) {
  const [names] = await Promise.all([getElements(), loadElements()]);
  setElements(names);
}
