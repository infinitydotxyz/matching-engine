import { ethers } from 'ethers';

import { getOBOrderPrice } from '@infinityxyz/lib/utils';

import {
  GetPriceAtTimeForEquation,
  LineSegment,
  LineSegmentEquation,
  OrderItemPrice,
  OrderPriceIntersection,
  Point
} from './intersection.types';

export function getOneToManyOrderIntersection(one: OrderItemPrice, many: OrderItemPrice[]) {
  const getPriceAtTime = (timestamp: number, equation: GetPriceAtTimeForEquation) => {
    if (timestamp >= equation.start.x && timestamp <= equation.end.x) {
      return equation.slope * timestamp + equation.yIntercept;
    }
    return null;
  };

  const equationsOfMany: LineSegmentEquation[] = many.map((segment) => {
    const start = {
      x: segment.startTimeMs,
      y: segment.startPriceEth
    };
    const end = {
      x: segment.endTimeMs,
      y: segment.endPriceEth
    };

    const slope = (end.y - start.y) / (end.x - start.x);
    const yIntercept = start.y - slope * start.x;

    return {
      slope,
      yIntercept,
      start,
      end
    };
  });

  type CombinedEquation = LineSegmentEquation & { valid: boolean; invalidEquation?: LineSegmentEquation };
  const combinedEquation = equationsOfMany.reduce(
    (acc: CombinedEquation, curr) => {
      if (!acc.valid) {
        return acc;
      }

      const slope = acc.slope + curr.slope;
      const yIntercept = acc.yIntercept + curr.yIntercept;

      const getCoordinate = (accCoord: number, currCoord: number, isStart: boolean) => {
        const select = isStart ? Math.max : Math.min;
        return Number.isNaN(accCoord) ? currCoord : select(accCoord, currCoord);
      };
      const startX = getCoordinate(acc.start.x, curr.start.x, true);
      const endX = getCoordinate(acc.end.x, curr.end.x, false);

      const updatedEquation: GetPriceAtTimeForEquation = {
        slope,
        yIntercept,
        start: {
          x: startX
        },
        end: {
          x: endX
        }
      };

      const startY = getPriceAtTime(startX, updatedEquation);
      const endY = getPriceAtTime(endX, updatedEquation);

      if (startY === null || endY === null) {
        return {
          ...acc,
          valid: false,
          invalidEquation: curr
        };
      }

      return {
        valid: true,
        invalidEquation: undefined,
        ...updatedEquation,
        start: {
          x: startX,
          y: startY
        },
        end: {
          x: endX,
          y: endY
        }
      };
    },
    {
      valid: true,
      invalidEquation: undefined,
      slope: 0,
      yIntercept: 0,
      start: { x: NaN, y: NaN },
      end: { x: NaN, y: NaN }
    }
  );

  if (!combinedEquation.valid) {
    return null;
  }

  const combinedLineSegment: OrderItemPrice = {
    isSellOrder: !one.isSellOrder,
    startTimeMs: combinedEquation.start.x,
    endTimeMs: combinedEquation.end.x,
    startPriceEth: combinedEquation.start.y,
    endPriceEth: combinedEquation.end.y
  };

  const intersection = getOrderIntersection(one, combinedLineSegment);
  return intersection;
}

export function getOrderIntersection(one: OrderItemPrice, two: OrderItemPrice): OrderPriceIntersection | null {
  const segmentOne: LineSegment = {
    start: {
      x: one.startTimeMs,
      y: one.startPriceEth
    },
    end: {
      x: one.endTimeMs,
      y: one.endPriceEth
    }
  };

  const segmentTwo: LineSegment = {
    start: {
      x: two.startTimeMs,
      y: two.startPriceEth
    },
    end: {
      x: two.endTimeMs,
      y: two.endPriceEth
    }
  };

  const minTimestamp = Math.max(segmentOne.start.x, segmentTwo.start.x);
  const maxTimestamp = Math.min(segmentOne.end.x, segmentTwo.end.x);

  const intersection = getIntersection(segmentOne, segmentTwo);

  if (intersection === null) {
    const [listing, offer] = one.isSellOrder ? [one, two] : [two, one];
    const timestampsOverlap = listing.startTimeMs <= offer.endTimeMs && listing.endTimeMs >= offer.startTimeMs;
    if (timestampsOverlap) {
      const timeValid = Math.max(listing.startTimeMs, offer.startTimeMs);
      const listingOrderPrice = getOBOrderPrice(listing, timeValid);
      const offerOrderPrice = getOBOrderPrice(offer, timeValid);
      const offerPriceIsGreaterThanListingPrice = offerOrderPrice.gte(listingOrderPrice);

      if (offerPriceIsGreaterThanListingPrice) {
        const nearestSecond = Math.ceil(timeValid / 1000) * 1000;
        const getPriceAtTime = (timestamp: number) => {
          if (timestamp < minTimestamp || timestamp > maxTimestamp) {
            return null;
          }
          const listingPrice = getOBOrderPrice(listing, timestamp);
          return parseFloat(ethers.utils.formatEther(listingPrice));
        };
        const price = getPriceAtTime(nearestSecond);
        if (price === null) {
          return null;
        }
        return {
          timestamp: nearestSecond,
          price,
          getPriceAtTime
        };
      }
    }

    return null;
  }

  const nearestSecond = Math.ceil(intersection.x / 1000) * 1000;
  const segmentOneSlope = (segmentOne.end.y - segmentOne.start.y) / (segmentOne.end.x - segmentOne.start.x);
  const yIntercept = segmentOne.start.y - segmentOneSlope * segmentOne.start.x;

  const getPriceAtTime = (timestamp: number) => {
    if (timestamp < minTimestamp || timestamp > maxTimestamp) {
      return null;
    }
    return segmentOneSlope * timestamp + yIntercept;
  };

  const price = getPriceAtTime(nearestSecond);
  if (price === null) {
    return null;
  }

  return {
    timestamp: nearestSecond,
    price,
    getPriceAtTime
  };
}

export function getIntersection(one: LineSegment, two: LineSegment): Point | null {
  const numerator =
    (one.start.x - two.start.x) * (two.start.y - two.end.y) - (one.start.y - two.start.y) * (two.start.x - two.end.x);
  const denominator =
    (one.start.x - one.end.x) * (two.start.y - two.end.y) - (one.start.y - one.end.y) * (two.start.x - two.end.x);
  const bezierParam = numerator / denominator;

  if (bezierParam < 0 || bezierParam > 1) {
    return null; // no intersection
  }

  if (Number.isNaN(bezierParam)) {
    // line intersection is a line segment
    const intersectionX = one.start.x < two.start.x ? two.start.x : one.start.x;
    const intersectionY = one.start.y < two.start.y ? two.start.y : one.start.y;
    return {
      x: intersectionX,
      y: intersectionY
    };
  }

  // line intersection is a point
  const intersectionX = one.start.x + bezierParam * (one.end.x - one.start.x);
  const intersectionY = one.start.y + bezierParam * (one.end.y - one.start.y);

  return {
    x: intersectionX,
    y: intersectionY
  };
}
