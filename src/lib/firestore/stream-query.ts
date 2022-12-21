interface StreamQueryWithRefOptions<
  DocumentData,
  TransformedPage = { data: DocumentData; ref: FirebaseFirestore.DocumentReference<DocumentData> },
  TransformedItem = TransformedPage
> {
  pageSize: number;
  transformPage?: (
    docs: { data: DocumentData; ref: FirebaseFirestore.DocumentReference<DocumentData> }[]
  ) => Promise<TransformedPage[]> | TransformedPage[];
  transformItem?: (pageItem?: TransformedPage) => Promise<TransformedItem> | TransformedItem;
}

export async function* streamQueryWithRef<
  DocumentData,
  TransformedPage = { data: DocumentData; ref: FirebaseFirestore.DocumentReference<DocumentData> },
  TransformedItem = TransformedPage
>(
  query: FirebaseFirestore.Query<DocumentData> | FirebaseFirestore.CollectionReference<DocumentData>,
  getStartAfterField: (
    item: DocumentData,
    ref: FirebaseFirestore.DocumentReference<DocumentData>
  ) => (string | number | FirebaseFirestore.DocumentReference<DocumentData>)[] = (item, ref) => [ref],
  options: StreamQueryWithRefOptions<DocumentData, TransformedPage, TransformedItem> = { pageSize: 300 }
): AsyncGenerator<TransformedItem> {
  let hasNextPage = true;
  let startAfter: (string | number | FirebaseFirestore.DocumentReference<DocumentData>)[] | undefined = undefined;
  while (hasNextPage) {
    let pageQuery = query;
    if (startAfter !== undefined) {
      pageQuery = pageQuery.startAfter(...startAfter);
    }
    const pageSnapshot = await pageQuery.limit(options.pageSize).get();
    const pageData = pageSnapshot.docs.map((item) => ({ data: item.data(), ref: item.ref }));

    const transformedPage: TransformedPage[] = (
      typeof options.transformPage === 'function' ? await options.transformPage(pageData) : pageData
    ) as TransformedPage[];
    for (const item of transformedPage) {
      const transformedItem = (
        options.transformItem && typeof options.transformItem === 'function' ? await options.transformItem(item) : item
      ) as TransformedItem;
      if (transformedItem) {
        yield transformedItem;
      }
    }

    hasNextPage = pageSnapshot.docs.length >= options.pageSize;

    startAfter = getStartAfterField(
      pageData?.[pageData.length - 1]?.data,
      pageSnapshot.docs?.[pageSnapshot.docs.length - 1]?.ref
    );
  }
}
