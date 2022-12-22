import { getOneToManyOrderIntersection } from './intersection';
import { testOrderIntersection } from './intersection.test';
import { OrderItemPrice } from './intersection.types';

const OFFER = false;
const LISTING = true;

describe('one to many intersection reduces to intersection', () => {
  const oneToOneToOneToMany = (one: OrderItemPrice, two: OrderItemPrice) => {
    return getOneToManyOrderIntersection(one, [two]);
  };
  testOrderIntersection(oneToOneToOneToMany);
});

describe('one to many intersection for fixed price orders', () => {
  it('Many order prices sum to less than single order offer', () => {
    const orderOne = {
      isSellOrder: OFFER,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 0.1,
      endPriceEth: 0.1
    };

    const many = [orderTwo, orderTwo];
    const sum = many.reduce((acc, curr) => acc + curr.startPriceEth, 0);

    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection?.timestamp).toBe(orderOne.startTimeMs);
    expect(intersection?.price).toBe(sum);
    expect(intersection?.getPriceAtTime(orderTwo.endTimeMs)).toBe(sum);
  });

  it('Many order prices sum to be single order offer', () => {
    const orderOne = {
      isSellOrder: OFFER,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 0.5,
      endPriceEth: 0.5
    };

    const many = [orderTwo, orderTwo];
    const sum = many.reduce((acc, curr) => acc + curr.startPriceEth, 0);

    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection?.timestamp).toBe(orderOne.startTimeMs);
    expect(intersection?.price).toBe(sum);
    expect(intersection?.getPriceAtTime(orderTwo.endTimeMs)).toBe(sum);
  });

  it('Many order prices sum to be more than single order offer', () => {
    const orderOne = {
      isSellOrder: OFFER,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const many = [orderTwo, orderTwo];
    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection).toBe(null);
  });

  it('Many order prices sum to be less than single order listing', () => {
    const orderOne = {
      isSellOrder: LISTING,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 0.1,
      endPriceEth: 0.1
    };

    const many = [orderTwo, orderTwo];

    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection).toBe(null);
  });

  it('Many order prices sum to be price of single order listing', () => {
    const orderOne = {
      isSellOrder: LISTING,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 0.5,
      endPriceEth: 0.5
    };

    const many = [orderTwo, orderTwo];

    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection?.price).toBe(orderOne.startPriceEth);
    expect(intersection?.timestamp).toBe(orderOne.startTimeMs);
    expect(intersection?.getPriceAtTime(orderTwo.endTimeMs)).toBe(orderOne.endPriceEth);
  });

  it('Many order prices sum to be more than the price of single order listing', () => {
    const orderOne = {
      isSellOrder: LISTING,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const many = [orderTwo, orderTwo];

    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection?.price).toBe(orderOne.startPriceEth);
    expect(intersection?.timestamp).toBe(orderOne.startTimeMs);
    expect(intersection?.getPriceAtTime(orderTwo.endTimeMs)).toBe(orderOne.endPriceEth);
  });

  it("Many order timestamps don't overlap", () => {
    const orderOne = {
      isSellOrder: LISTING,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderThree = {
      ...orderTwo,
      startTimeMs: orderOne.endTimeMs + 1,
      endTimeMs: orderOne.endTimeMs + 2
    };
    const many = [orderTwo, orderThree];
    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection).toBe(null);
  });

  it("Many order timestamps overlap, but don't overlap with single order", () => {
    const orderOne = {
      isSellOrder: LISTING,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.endTimeMs + 1,
      endTimeMs: orderOne.endTimeMs + 2,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const many = [orderTwo, orderTwo];
    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection).toBe(null);
  });

  it('Many order timestamps partially overlap to form sub segment that overlaps with single order', () => {
    const orderOne = {
      isSellOrder: LISTING,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: 125_000,
      endTimeMs: 175_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderThree = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: 150_000,
      endTimeMs: 190_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const many = [orderTwo, orderThree];
    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection?.price).toBe(orderOne.startPriceEth);
    expect(intersection?.timestamp).toBe(orderThree.startTimeMs);
    expect(intersection?.getPriceAtTime(orderOne.startTimeMs)).toBe(null);
    expect(intersection?.getPriceAtTime(orderOne.endTimeMs)).toBe(null);
    expect(intersection?.getPriceAtTime(orderTwo.startTimeMs)).toBe(null);
    expect(intersection?.getPriceAtTime(orderThree.endTimeMs)).toBe(null);
    expect(intersection?.getPriceAtTime(orderThree.startTimeMs)).toBe(orderOne.startPriceEth);
    expect(intersection?.getPriceAtTime(orderTwo.endTimeMs)).toBe(orderOne.startPriceEth);
  });
});

describe('one to many intersection for auction orders', () => {
  it('Many order prices sum to less than single order offer', () => {
    const orderOne = {
      isSellOrder: OFFER,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 0.3,
      endPriceEth: 0.1
    };

    const orderThree = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 0.1,
      endPriceEth: 0.3
    };

    const many = [orderTwo, orderThree];
    const intersection = getOneToManyOrderIntersection(orderOne, many);
    const price = orderTwo.startPriceEth + orderThree.startPriceEth;
    expect(intersection?.timestamp).toBe(orderOne.startTimeMs);
    expect(intersection?.price).toBe(price);
    expect(intersection?.getPriceAtTime(orderTwo.endTimeMs)).toBe(price);

    const midMatchTimestamp = (orderTwo.startTimeMs + orderTwo.endTimeMs) / 2;
    expect(intersection?.getPriceAtTime(midMatchTimestamp)).toBe(price);
  });

  it('Many order prices sum to be single order offer', () => {
    const orderOne = {
      isSellOrder: OFFER,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 0.75,
      endPriceEth: 0.25
    };

    const orderThree = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 0.25,
      endPriceEth: 0.75
    };

    const many = [orderTwo, orderThree];
    const sum = 1;

    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection?.timestamp).toBe(orderOne.startTimeMs);
    expect(intersection?.price).toBe(sum);
    expect(intersection?.getPriceAtTime(orderTwo.endTimeMs)).toBe(sum);
  });

  it('Many order prices sum to be more than single order offer', () => {
    const orderOne = {
      isSellOrder: OFFER,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 0.5,
      endPriceEth: 1
    };

    const orderThree = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 1,
      endPriceEth: 0.5
    };

    const many = [orderTwo, orderThree];
    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection).toBe(null);
  });

  it('Many order prices sum to be less than single order listing', () => {
    const orderOne = {
      isSellOrder: LISTING,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 0.1,
      endPriceEth: 0.2
    };

    const orderThree = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 0.2,
      endPriceEth: 0.4
    };

    const many = [orderTwo, orderThree];

    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection).toBe(null);
  });

  it('Many order prices sum to be price of single order listing', () => {
    const orderOne = {
      isSellOrder: LISTING,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 2
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 0.5,
      endPriceEth: 1
    };

    const orderThree = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 0.5,
      endPriceEth: 1
    };

    const many = [orderTwo, orderThree];

    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection?.price).toBe(orderOne.startPriceEth);
    expect(intersection?.timestamp).toBe(orderOne.startTimeMs);
    expect(intersection?.getPriceAtTime(orderOne.endTimeMs)).toBe(orderOne.endPriceEth);
  });

  it('Many order prices sum to be more than the price of single order listing', () => {
    const orderOne = {
      isSellOrder: LISTING,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 0.375,
      endPriceEth: 0.75
    };

    const orderThree = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 2,
      endPriceEth: 1
    };

    const many = [orderTwo, orderThree];

    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection?.price).toBe(orderOne.startPriceEth);
    expect(intersection?.timestamp).toBe(orderOne.startTimeMs);
    expect(intersection?.getPriceAtTime(orderOne.endTimeMs)).toBe(orderOne.endPriceEth);
  });

  it("Many order timestamps don't overlap", () => {
    const orderOne = {
      isSellOrder: LISTING,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.startTimeMs,
      endTimeMs: orderOne.endTimeMs,
      startPriceEth: 1,
      endPriceEth: 2
    };

    const orderThree = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.endTimeMs + 100_000,
      endTimeMs: orderOne.endTimeMs + 200_000,
      startPriceEth: 2,
      endPriceEth: 1
    };
    const many = [orderTwo, orderThree];
    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection).toBe(null);
  });

  it("Many order timestamps overlap, but don't overlap with single order", () => {
    const orderOne = {
      isSellOrder: LISTING,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 2,
      endPriceEth: 1
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: orderOne.endTimeMs + 1,
      endTimeMs: orderOne.endTimeMs + 200_000,
      startPriceEth: 1,
      endPriceEth: 2
    };

    const many = [orderTwo, orderTwo];
    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection).toBe(null);
  });

  it('Many order timestamps partially overlap to form sub segment that overlaps with single order', () => {
    const orderOne = {
      isSellOrder: LISTING,
      startTimeMs: 100_000,
      endTimeMs: 200_000,
      startPriceEth: 1,
      endPriceEth: 2
    };

    const orderTwo = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: 125_000,
      endTimeMs: 175_000,
      startPriceEth: 1.25,
      endPriceEth: 1.75
    };

    const orderThree = {
      isSellOrder: !orderOne.isSellOrder,
      startTimeMs: 150_000,
      endTimeMs: 190_000,
      startPriceEth: 1.5,
      endPriceEth: 1.9
    };

    const many = [orderTwo, orderThree];
    const intersection = getOneToManyOrderIntersection(orderOne, many);

    expect(intersection?.price).toBe(1.5);
    expect(intersection?.timestamp).toBe(orderThree.startTimeMs);
    expect(intersection?.getPriceAtTime(orderOne.startTimeMs)).toBe(null);
    expect(intersection?.getPriceAtTime(orderOne.endTimeMs)).toBe(null);
    expect(intersection?.getPriceAtTime(orderTwo.startTimeMs)).toBe(null);
    expect(intersection?.getPriceAtTime(orderThree.endTimeMs)).toBe(null);
    expect(intersection?.getPriceAtTime(orderThree.startTimeMs)).toBe(1.5);
    expect(intersection?.getPriceAtTime(orderTwo.endTimeMs)).toBe(1.75);
  });
});
