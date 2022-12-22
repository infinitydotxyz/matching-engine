export type OrderPriceIntersection = {
  timestamp: number;
  price: number;
  getPriceAtTime: (timestamp: number) => number | null;
};

export type Point = {
  x: number;
  y: number;
};

export type LineSegment = {
  start: Point;
  end: Point;
};

export type LineSegmentEquation = {
  slope: number;
  yIntercept: number;
  start: Point;
  end: Point;
};

export type GetPriceAtTimeForEquation = {
  slope: number;
  yIntercept: number;
  start: Pick<Point, 'x'>;
  end: Pick<Point, 'x'>;
};

export type OrderItemPrice = {
  isSellOrder: boolean;
  startTimeMs: number;
  endTimeMs: number;
  startPriceEth: number;
  endPriceEth: number;
};
