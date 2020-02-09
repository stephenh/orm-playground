import { EntityManager } from "../EntityManager";
import { knex } from "../setupDbTests";
import { Book } from "../../integration/Book";
import { Author } from "../../integration/Author";
import { keyToNumber, keyToString } from "../serde";

describe("OneToManyCollection", () => {
  it("loads collections", async () => {
    await knex.insert({ first_name: "a1" }).into("authors");
    await knex.insert({ title: "t1", author_id: 1 }).into("books");
    await knex.insert({ title: "t2", author_id: 1 }).into("books");

    const em = new EntityManager(knex);
    const a1 = await em.load(Author, "1");
    const books = await a1.books.load();
    expect(books.length).toEqual(2);
  });

  it("loads collections with instances already in the UoW", async () => {
    await knex.insert({ first_name: "a1" }).into("authors");
    await knex.insert({ title: "t1", author_id: 1 }).into("books");
    await knex.insert({ title: "t2", author_id: 1 }).into("books");

    const em = new EntityManager(knex);
    const t1 = await em.load(Book, "1");
    const a1 = await em.load(Author, "1");
    const books = await a1.books.load();
    expect(books[0] === t1).toEqual(true);
  });

  it("references use collection-loaded instances from the UoW", async () => {
    await knex.insert({ first_name: "a1" }).into("authors");
    await knex.insert({ title: "t1", author_id: 1 }).into("books");
    await knex.insert({ title: "t2", author_id: 1 }).into("books");

    const em = new EntityManager(knex);
    const a1 = await em.load(Author, "1");
    const books = await a1.books.load();
    // Pretend this is a reference
    const t1 = await em.load(Book, "1");
    expect(books[0] === t1).toEqual(true);
  });

  it("can add to collection", async () => {
    const em = new EntityManager(knex);
    const b1 = em.create(Book, { title: "b1" });
    const a1 = em.create(Author, { firstName: "a1" });
    a1.books.add(b1);
    expect(b1.author.get()).toEqual(a1);
    await em.flush();

    const rows = await knex.select("*").from("books");
    expect(rows[0].author_id).toEqual(1);
  });

  it("can add to one collection and remove from other", async () => {
    // Given a book that has two potential authors as all new objects.
    const em = new EntityManager(knex);
    const b1 = em.create(Book, { title: "b1" });
    const a1 = em.create(Author, { firstName: "a1" });
    const a2 = em.create(Author, { firstName: "a2" });

    // When we add it to the 1st
    a1.books.add(b1);
    expect(a1.books.get()).toContain(b1);

    // But then add it to the 2nd author
    a2.books.add(b1);

    // Then the book is associated with only the 2nd author
    expect(b1.author.get()).toEqual(a2);
    expect(a1.books.get().length).toEqual(0);
    expect(a2.books.get().length).toEqual(1);

    // And the book association to a2 is persisted to the database.
    await em.flush();
    const rows = await knex.select("*").from("books");
    expect(rows[0].author_id).toEqual(keyToNumber(a2.id));
  });

  it("can add to one collection and remove from other when already persisted", async () => {
    // Given a book that has two potential authors as already persisted entities
    {
      const em = new EntityManager(knex);
      const b1 = em.create(Book, { title: "b1" });
      const a1 = em.create(Author, { firstName: "a1" });
      em.create(Author, { firstName: "a2" });
      b1.author.set(a1);
      await em.flush();
    }

    const em2 = new EntityManager(knex);
    // TODO Use populate when we have it.
    const b1_2 = await em2.load(Book, "1");
    const a1_2 = await em2.load(Author, "1");
    const a2_2 = await em2.load(Author, "2");

    // When we add the book to the 2nd author
    a2_2.books.add(b1_2);

    // Then the book is associtiated with only the 2nd author
    expect(await b1_2.author.load()).toEqual(a2_2);
    expect((await a1_2.books.load()).length).toEqual(0);
    expect((await a2_2.books.load()).length).toEqual(1);

    // And the book association to a2 is persisted to the database.
    await em2.flush();
    const rows = await knex.select("*").from("books");
    expect(rows[0].author_id).toEqual(keyToNumber(a2_2.id));
  });

  it("can add to collection from the other side", async () => {
    const em = new EntityManager(knex);
    const b1 = em.create(Book, { title: "b1" });
    const a1 = em.create(Author, { firstName: "a1" });
    b1.author.set(a1);
    expect(a1.books.get()).toContain(b1);
  });

  it("combines both pre-loaded and post-loaded entities", async () => {
    // Given an author with one book
    await knex.insert({ first_name: "a1" }).into("authors");
    await knex.insert({ title: "b1", author_id: 1 }).into("books");
    // And we load the author
    const em = new EntityManager(knex);
    const a1 = await em.load(Author, "1");

    // When we give the author a new book
    const b2 = em.create(Book, { title: "b2" });
    a1.books.add(b2);
    // And load the books collection
    const books = await a1.books.load();

    // Then the collection has both books in it
    expect(books.length).toEqual(2);
    expect(books[0].id).toEqual(undefined);
    expect(books[1].id).toEqual("1");
  });
});
