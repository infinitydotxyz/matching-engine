import { getOrderIntersection } from './intersection';
import { OrderItemPrice, OrderPriceIntersection } from './intersection.types';

export const testOrderIntersection = (
  fn: (one: OrderItemPrice, two: OrderItemPrice) => OrderPriceIntersection | null
) => {
  it('should be defined', () => {
    expect(fn).toBeDefined();
  });

  it("should return null if timestamps don't overlap", () => {
    const orderOnePrice = {
      isSellOrder: true,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 2
    };

    const orderTwoPrice = {
      isSellOrder: false,
      startTimeMs: 300_000,
      endTimeMs: 400_000,
      startPriceEth: 1,
      endPriceEth: 2
    };

    const intersection = fn(orderOnePrice, orderTwoPrice);
    expect(intersection).toBeNull();
  });

  it("should return an intersection if prices don't overlap and the buy order has a higher price than the sell order", () => {
    const orderOne = {
      isSellOrder: true,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 2
    };

    const orderTwo = {
      isSellOrder: false,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 3,
      endPriceEth: 4
    };

    const intersection = fn(orderOne, orderTwo);
    if (intersection == null) {
      expect(intersection).toBeTruthy();
      return;
    }
    expect(intersection.price).toBe(orderOne.startPriceEth);
    expect(intersection.timestamp).toBe(orderOne.startTimeMs);
  });

  it("should return null if prices don't overlap and the sell order has a higher price than the buy order", () => {
    const orderOne = {
      isSellOrder: false,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 2
    };

    const orderTwo = {
      isSellOrder: true,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 3,
      endPriceEth: 4
    };

    const intersection = fn(orderOne, orderTwo);
    expect(intersection).toBeNull();
  });

  it('should handle lines the barely overlap', () => {
    const orderOne = {
      isSellOrder: true,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 2
    };

    const orderTwo = {
      isSellOrder: false,
      startTimeMs: orderOne.endTimeMs,
      endTimeMs: orderOne.endTimeMs + 100_000,
      startPriceEth: orderOne.endPriceEth,
      endPriceEth: orderOne.startPriceEth
    };

    const intersection = fn(orderOne, orderTwo);
    expect(intersection).not.toBeNull();
    if (intersection == null) {
      expect(intersection).toBeTruthy();
      return;
    }
    expect(intersection.price).toEqual(orderOne.endPriceEth);
    expect(intersection.timestamp).toEqual(orderOne.endTimeMs);
  });

  it("should return null for parallel lines that don't overlap and the listing is priced above the offer", () => {
    const orderOne = {
      isSellOrder: true,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 2,
      endPriceEth: 2
    };

    const orderTwo = {
      isSellOrder: false,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const intersection = fn(orderOne, orderTwo);
    expect(intersection).toBeNull();
  });

  it("should return an intersection for parallel lines that don't overlap and the offer is priced above the listing", () => {
    const orderOne = {
      isSellOrder: true,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: false,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 2,
      endPriceEth: 2
    };

    const intersection = fn(orderOne, orderTwo);
    if (intersection == null) {
      expect(intersection).toBeTruthy();
      return;
    }
    expect(intersection.price).toBe(orderOne.startPriceEth);
    expect(intersection.timestamp).toBe(orderOne.startTimeMs);
  });

  it('should return the first intersection point if the intersection forms a line. orderOne === orderTwo', () => {
    const orderOne = {
      isSellOrder: true,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const intersection = fn(orderOne, { ...orderOne, isSellOrder: false });
    if (intersection == null) {
      expect(intersection).toBeTruthy();
      return;
    }
    expect(intersection.timestamp).toBeCloseTo(orderOne.startTimeMs);
    expect(intersection.price).toBeCloseTo(orderOne.startPriceEth);
  });

  it('should return the first intersection point if the intersection forms a line. orderTwo is a subset of orderOne', () => {
    const orderOne = {
      isSellOrder: true,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 2
    };
    const orderTwo = {
      isSellOrder: false,
      startTimeMs: 125_000,
      endTimeMs: 175_000,
      startPriceEth: 1.25,
      endPriceEth: 1.75
    };
    const intersection = fn(orderOne, orderTwo);
    if (intersection == null) {
      expect(intersection).toBeTruthy();
      return;
    }
    expect(intersection.timestamp).toBeCloseTo(orderTwo.startTimeMs);
    expect(intersection.price).toBeCloseTo(orderTwo.startPriceEth);
  });

  it('should return the first intersection point if the intersection forms a line. orderOne is a subset of orderTwo', () => {
    const orderOne = {
      isSellOrder: true,
      startTimeMs: 125_000,
      endTimeMs: 175_000,
      startPriceEth: 1.25,
      endPriceEth: 1.75
    };
    const orderTwo = {
      isSellOrder: false,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 2
    };
    const intersection = fn(orderOne, orderTwo);
    if (intersection == null) {
      expect(intersection).toBeTruthy();
      return;
    }
    expect(intersection.timestamp).toBeCloseTo(orderOne.startTimeMs);
    expect(intersection.price).toBeCloseTo(orderOne.startPriceEth);
  });

  it('should return the correct intersection point for a basic intersection', () => {
    const orderOne = {
      isSellOrder: true,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 2
    };

    const orderTwo = {
      isSellOrder: false,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 2,
      endPriceEth: 1
    };

    const intersection = fn(orderOne, orderTwo);
    if (intersection == null) {
      expect(intersection).toBeTruthy();
      return;
    }
    expect(intersection.timestamp).toBeCloseTo(150_000);
    expect(intersection.price).toBeCloseTo(1.5);
  });
};

describe('intersection', () => {
  testOrderIntersection(getOrderIntersection);
});
